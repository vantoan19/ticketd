use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use pulldown_cmark::{Event, LinkType, Options, Parser, Tag};
use serde::{Deserialize, Serialize};

use crate::{Attachment, AttachmentKind, Error, Workspace, attachments};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MarkdownExportSource {
    Document {
        id: String,
    },
    Ticket {
        reference: String,
    },
    /// Current editor content or selected Markdown, independent of a save.
    Markdown {
        body: String,
    },
    /// Selection plus its source, so definitions outside the selected range can
    /// remain usable without exporting unrelated content.
    Selection {
        body: String,
        context: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportStatus {
    Complete,
    Partial,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportAttachment {
    pub uri: String,
    pub attachment_id: Option<String>,
    pub display_name: String,
    pub original_filename: Option<String>,
    pub path: Option<String>,
    pub external_url: Option<String>,
    pub omission: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarkdownExport {
    pub format_version: u32,
    pub status: ExportStatus,
    pub directory: PathBuf,
    pub markdown_path: String,
    pub manifest_path: String,
    pub attachments: Vec<ExportAttachment>,
}

impl Workspace {
    /// Create a fresh bundle in an existing output folder. No existing file is
    /// replaced; failed output is removed and missing inputs become manifest omissions.
    pub fn export_markdown_with_files(
        &self,
        source: MarkdownExportSource,
        output: impl AsRef<Path>,
    ) -> Result<MarkdownExport, Error> {
        // Use the same file-lock-before-SQLite order as backup and upload recovery.
        let _files = self.attachment_backup_lock()?;
        let tx = self.connection.unchecked_transaction()?;
        let (mut body, direct) = match source {
            MarkdownExportSource::Markdown { body } => (body, Vec::new()),
            MarkdownExportSource::Selection { body, context } => {
                (selection_with_definitions(&body, &context), Vec::new())
            }
            MarkdownExportSource::Document { id } => (self.show_document(&id)?.body, Vec::new()),
            MarkdownExportSource::Ticket { reference } => {
                let ticket = self.show_ticket(&reference)?;
                let mut query = tx.prepare("SELECT attachment_id FROM ticket_attachments WHERE ticket_id=?1 ORDER BY attachment_id")?;
                let ids = query
                    .query_map([&ticket.id], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                (
                    format!(
                        "# {} · {}\n\n{}",
                        ticket.reference, ticket.title, ticket.body
                    ),
                    ids,
                )
            }
        };
        let stage = tempfile::Builder::new()
            .prefix("ticketd-export-")
            .tempdir_in(output)?;
        fs::create_dir(stage.path().join("files"))?;
        let workspace_id = crate::embedded_attachments::workspace_id(&tx)?;
        let mut uris = BTreeSet::new();
        for event in parse(&body) {
            if let Event::Html(ref html) | Event::InlineHtml(ref html) = event {
                uris.extend(html_uris(html).into_iter().map(|(_, uri)| uri.to_owned()));
            } else if let Event::Start(Tag::Link { dest_url, .. } | Tag::Image { dest_url, .. }) =
                event
                && dest_url
                    .to_ascii_lowercase()
                    .starts_with("ticketd://attachment/")
            {
                uris.insert(dest_url.into_string());
            }
        }
        for id in &direct {
            uris.insert(format!("ticketd://attachment/{workspace_id}/{id}"));
        }
        let mut entries = Vec::new();
        let mut replacements = BTreeMap::new();
        let mut copied = BTreeMap::<String, ExportAttachment>::new();
        for uri in uris {
            let mut entry = ExportAttachment {
                uri: uri.clone(),
                attachment_id: None,
                display_name: uri.clone(),
                original_filename: None,
                path: None,
                external_url: None,
                omission: None,
            };
            let prefix = format!("ticketd://attachment/{workspace_id}/");
            let normalized = if uri
                .get(..21)
                .is_some_and(|s| s.eq_ignore_ascii_case("ticketd://attachment/"))
            {
                format!("ticketd://attachment/{}", &uri[21..])
            } else {
                uri.clone()
            };
            if let Some(id) = normalized.strip_prefix(&prefix) {
                entry.attachment_id = Some(id.into());
                match attachments::read_attachment(&tx, id) {
                    Ok(file) => {
                        entry.display_name = file.display_name.clone();
                        entry.original_filename = Some(file.original_filename.clone());
                        if let Some(previous) = copied.get(id) {
                            entry.path.clone_from(&previous.path);
                            entry.external_url.clone_from(&previous.external_url);
                            entry.omission.clone_from(&previous.omission);
                        } else {
                            self.copy_export_attachment(&file, stage.path(), &mut entry)?;
                            copied.insert(id.into(), entry.clone());
                        }
                    }
                    Err(Error::Attachment(message)) => entry.omission = Some(message),
                    Err(error) => return Err(error),
                }
            } else {
                entry.omission = Some("This reference belongs to another workspace; export it from its owning workspace.".into());
            }
            if let Some(target) = entry.path.as_ref().or(entry.external_url.as_ref()) {
                replacements.insert(uri, target.clone());
            }
            entries.push(entry);
        }
        body = rewrite(&body, &replacements);
        if !direct.is_empty() {
            body.push_str("\n\n## Direct attachments\n\n");
            for id in direct {
                if let Some(entry) = entries
                    .iter()
                    .find(|e| e.attachment_id.as_ref() == Some(&id))
                {
                    let target = entry
                        .path
                        .as_ref()
                        .or(entry.external_url.as_ref())
                        .unwrap_or(&entry.uri);
                    let label = entry
                        .display_name
                        .replace('\\', "\\\\")
                        .replace('[', "\\[")
                        .replace(']', "\\]");
                    body.push_str(&format!("- [{label}]({target})\n"));
                }
            }
        }
        let result = MarkdownExport {
            format_version: 1,
            status: if entries.iter().any(|e| e.omission.is_some()) {
                ExportStatus::Partial
            } else {
                ExportStatus::Complete
            },
            directory: stage.path().to_owned(),
            markdown_path: "content.md".into(),
            manifest_path: "manifest.json".into(),
            attachments: entries,
        };
        write_synced(&stage.path().join("content.md"), body.as_bytes())?;
        write_synced(
            &stage.path().join("manifest.json"),
            &serde_json::to_vec_pretty(&result)?,
        )?;
        tx.commit()?;
        let _ = stage.keep();
        Ok(result)
    }

    fn copy_export_attachment(
        &self,
        file: &Attachment,
        folder: &Path,
        entry: &mut ExportAttachment,
    ) -> Result<(), Error> {
        match file.kind {
            AttachmentKind::ExternalReference => {
                let reference = self.drive_reference(&file.id)?;
                if crate::drive::safe_web_url(&reference.metadata.web_url) {
                    entry.external_url = Some(reference.metadata.web_url);
                } else {
                    entry.omission =
                        Some("Invalid provider link; select the file in Drive again.".into());
                }
            }
            AttachmentKind::LocalSnapshot => {
                let path = match attachments::validate_attachment_bytes(&self.connection, file) {
                    Ok(path) => path,
                    Err(Error::Attachment(message)) => {
                        entry.omission = Some(message);
                        return Ok(());
                    }
                    Err(error) => return Err(error),
                };
                // Identity-prefixed ASCII names are collision safe on case-insensitive
                // filesystems, and cannot introduce paths, reserved names or Markdown syntax.
                let name: String = file
                    .original_filename
                    .chars()
                    .take(100)
                    .map(|c| {
                        if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                            c
                        } else {
                            '_'
                        }
                    })
                    .collect();
                let relative = format!("files/{}-{name}", file.id);
                let output = folder.join(&relative);
                let mut input = match fs::File::open(path) {
                    Ok(input) => input,
                    Err(error) => {
                        entry.omission = Some(format!(
                            "Cannot read stored bytes: {error}; restore the snapshot and retry."
                        ));
                        return Ok(());
                    }
                };
                let mut destination = fs::File::create(&output)?;
                let count = std::io::copy(&mut input, &mut destination)?;
                if Some(count) != file.size_bytes {
                    drop(destination);
                    fs::remove_file(output)?;
                    entry.omission = Some(
                        "Stored bytes changed during export; restore the snapshot and retry."
                            .into(),
                    );
                } else {
                    destination.sync_all()?;
                    entry.path = Some(relative);
                }
            }
        }
        Ok(())
    }
}

fn write_synced(path: &Path, bytes: &[u8]) -> Result<(), Error> {
    let mut file = fs::File::create(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn selection_with_definitions(body: &str, context: &str) -> String {
    let source = parse(context);
    let selected = parse(body);
    let mut candidate = body.to_owned();
    for (_, definition) in source.reference_definitions().iter() {
        candidate.push_str("\n\n");
        candidate.push_str(&context[definition.span.clone()]);
    }
    let mut used = BTreeSet::new();
    for event in parse(&candidate) {
        if let Event::Start(Tag::Link { link_type, id, .. } | Tag::Image { link_type, id, .. }) =
            event
            && matches!(
                link_type,
                LinkType::Reference | LinkType::Collapsed | LinkType::Shortcut
            )
            && selected.reference_definitions().get(&id).is_none()
            && let Some(definition) = source.reference_definitions().get(&id)
        {
            used.insert((definition.span.start, definition.span.end));
        }
    }
    let mut output = body.to_owned();
    for (start, end) in used {
        output.push_str("\n\n");
        output.push_str(&context[start..end]);
    }
    output
}

/// Replace destinations only, leaving labels, surrounding prose and code literal.
fn rewrite(body: &str, targets: &BTreeMap<String, String>) -> String {
    let parser = parse(body);
    let mut edits = Vec::new();
    for (_, definition) in parser.reference_definitions().iter() {
        if let Some(target) = targets.get(definition.dest.as_ref()) {
            let range = definition.span.clone();
            if let Some(colon) = body[range.clone()].find("]:") {
                let start = range.start + colon + 2;
                edits.push((destination_range(body, start, range.end), target.clone()));
            }
        }
    }
    for (event, range) in parser.into_offset_iter() {
        if let Event::Html(ref html) | Event::InlineHtml(ref html) = event {
            for (at, uri) in html_uris(html) {
                if let Some(target) = targets.get(uri) {
                    edits.push((
                        range.start + at..range.start + at + uri.len(),
                        target.clone(),
                    ));
                }
            }
        } else if let Event::Start(
            Tag::Link {
                link_type,
                dest_url,
                ..
            }
            | Tag::Image {
                link_type,
                dest_url,
                ..
            },
        ) = event
        {
            let Some(target) = targets.get(dest_url.as_ref()) else {
                continue;
            };
            if link_type == LinkType::Inline {
                // Titles and link labels can themselves contain ](. Only replace
                // the parsed destination, never a matching-looking piece of prose.
                let destination = body[range.clone()].match_indices("](")
                    .map(|(offset, _)| destination_range(body, range.start + offset + 2, range.end))
                    .filter(|candidate| {
                        let example = format!("[x](<{}>)", &body[candidate.clone()]);
                        Parser::new(&example).any(|e| matches!(e, Event::Start(Tag::Link { dest_url: parsed, .. }) if parsed == dest_url))
                    }).last();
                if let Some(destination) = destination {
                    edits.push((destination, target.clone()));
                }
            } else if matches!(link_type, LinkType::Autolink) {
                edits.push((range, format!("[{dest_url}]({target})")));
            }
        }
    }
    edits.sort_by_key(|(range, _)| range.start);
    edits.dedup_by(|a, b| a.0 == b.0);
    let mut output = body.to_owned();
    for (range, target) in edits.into_iter().rev() {
        output.replace_range(range, &target);
    }
    output
}

fn parse(body: &str) -> Parser<'_> {
    Parser::new_ext(
        body,
        Options::ENABLE_TABLES | Options::ENABLE_TASKLISTS | Options::ENABLE_STRIKETHROUGH,
    )
}

fn html_uris(html: &str) -> Vec<(usize, &str)> {
    html.to_ascii_lowercase()
        .match_indices("ticketd://attachment/")
        .map(|(at, _)| {
            let uri = html[at..]
                .split(|c: char| c.is_whitespace() || matches!(c, '\'' | '"' | '<' | '>'))
                .next()
                .unwrap_or_default();
            (at, uri)
        })
        .collect()
}

fn destination_range(body: &str, start: usize, end: usize) -> std::ops::Range<usize> {
    let text = &body[start..end];
    let leading = text.len() - text.trim_start().len();
    let start = start + leading;
    if body.as_bytes().get(start) == Some(&b'<') {
        let length = body[start + 1..end].find('>').unwrap_or(end - start - 1);
        return start + 1..start + 1 + length;
    }
    let mut depth = 0;
    let mut escaped = false;
    for (offset, c) in body[start..end].char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if c == '\\' {
            escaped = true;
            continue;
        }
        if c == '(' {
            depth += 1;
        }
        if c.is_whitespace() || (c == ')' && depth == 0) {
            return start..start + offset;
        }
        if c == ')' {
            depth -= 1;
        }
    }
    start..end
}
