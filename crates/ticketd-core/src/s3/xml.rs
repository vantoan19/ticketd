//! The few XML answers S3 gives: errors and the two listings.
use quick_xml::Reader;
use quick_xml::events::Event;

/// One S3 error body: `<Error><Code>…</Code><Message>…</Message></Error>`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct ErrorBody {
    pub code: String,
    pub message: String,
}

/// What the elements of an answer say, in document order.
enum Item {
    Open(String),
    Close(String),
    /// `(parent, name, text)` of an element that holds text.
    Text(String, String, String),
}

fn items(xml: &[u8]) -> Option<Vec<Item>> {
    let text = std::str::from_utf8(xml).ok()?;
    let mut reader = Reader::from_str(text);
    let mut path: Vec<String> = Vec::new();
    let mut out = Vec::new();
    let mut content = String::new();
    loop {
        match reader.read_event().ok()? {
            Event::Start(start) => {
                let name = start.local_name().as_ref().to_owned();
                out.push(Item::Open(name.clone()));
                path.push(name);
                content.clear();
            }
            Event::Text(text) => content.push_str(&text.xml10_content()),
            Event::GeneralRef(reference) => match reference.resolve_char_ref().ok()? {
                Some(character) => content.push(character),
                None => content.push_str(entity(&reference)?),
            },
            Event::End(_) => {
                let name = path.pop()?;
                // Whitespace between child elements is layout, not a value.
                if !content.trim().is_empty() {
                    let parent = path.last().cloned().unwrap_or_default();
                    out.push(Item::Text(parent, name.clone(), content.clone()));
                }
                content.clear();
                out.push(Item::Close(name));
            }
            Event::Empty(empty) => {
                let name = empty.local_name().as_ref().to_owned();
                out.push(Item::Open(name.clone()));
                out.push(Item::Close(name));
            }
            Event::Eof => break,
            _ => {}
        }
    }
    path.is_empty().then_some(out)
}

/// The five entities XML predefines; character references are resolved by the reader.
fn entity(name: &str) -> Option<&'static str> {
    Some(match name {
        "quot" => "\"",
        "amp" => "&",
        "apos" => "'",
        "lt" => "<",
        "gt" => ">",
        _ => return None,
    })
}

pub(crate) fn error_body(xml: &[u8]) -> Option<ErrorBody> {
    let mut error = ErrorBody::default();
    let mut seen = false;
    for item in items(xml)? {
        if let Item::Text(parent, name, text) = item
            && parent == "Error"
        {
            seen = true;
            match name.as_str() {
                "Code" => error.code = text,
                "Message" => error.message = text,
                _ => {}
            }
        }
    }
    seen.then_some(error)
}

/// GetBucketVersioning: `Some("Enabled")` or `Some("Suspended")`, or `None` for a bucket that
/// never had Versioning. The outer `None` is an answer that is not a versioning configuration.
pub(crate) fn versioning_status(xml: &[u8]) -> Option<Option<String>> {
    let items = items(xml)?;
    items
        .iter()
        .any(|item| matches!(item, Item::Open(name) if name == "VersioningConfiguration"))
        .then(|| {
            items.into_iter().find_map(|item| match item {
                Item::Text(parent, name, text)
                    if parent == "VersioningConfiguration" && name == "Status" =>
                {
                    Some(text)
                }
                _ => None,
            })
        })
}

/// One entry of ListObjectVersions, in the order S3 listed it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Listed {
    pub key: String,
    pub version_id: String,
    pub modified: String,
    /// What a delete marker does not have: its content.
    pub content: Option<Content>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Content {
    pub etag: String,
    pub size: u64,
}

impl Listed {
    pub(crate) fn is_delete_marker(&self) -> bool {
        self.content.is_none()
    }
}

#[derive(Debug, Default)]
pub(crate) struct VersionsPage {
    pub entries: Vec<Listed>,
    pub truncated: bool,
    pub next_key_marker: Option<String>,
    pub next_version_marker: Option<String>,
}

/// Versions and delete markers arrive as two kinds of element, interleaved in the order the
/// document gives them: newest first within a key.
pub(crate) fn versions_page(xml: &[u8]) -> Option<VersionsPage> {
    #[derive(Default)]
    struct Draft {
        key: String,
        version_id: String,
        modified: String,
        etag: String,
        size: Option<u64>,
    }
    let mut page = VersionsPage::default();
    let mut open: Option<Draft> = None;
    for item in items(xml)? {
        match item {
            Item::Open(name) if name == "Version" || name == "DeleteMarker" => {
                open = Some(Draft::default());
            }
            Item::Close(name) if name == "Version" || name == "DeleteMarker" => {
                let draft = open.take()?;
                if draft.key.is_empty() || draft.version_id.is_empty() {
                    return None;
                }
                let content = if name == "Version" {
                    Some(Content {
                        etag: draft.etag,
                        size: draft.size?,
                    })
                } else {
                    None
                };
                page.entries.push(Listed {
                    key: draft.key,
                    version_id: draft.version_id,
                    modified: draft.modified,
                    content,
                });
            }
            Item::Text(parent, name, text) => match (parent.as_str(), name.as_str()) {
                ("Version" | "DeleteMarker", field) => {
                    if let Some(draft) = open.as_mut() {
                        match field {
                            "Key" => draft.key = text,
                            "VersionId" => draft.version_id = text,
                            "LastModified" => draft.modified = text,
                            "ETag" => draft.etag = text,
                            "Size" => draft.size = Some(text.parse().ok()?),
                            _ => {}
                        }
                    }
                }
                ("ListVersionsResult", "IsTruncated") => page.truncated = text == "true",
                ("ListVersionsResult", "NextKeyMarker") => page.next_key_marker = Some(text),
                ("ListVersionsResult", "NextVersionIdMarker") => {
                    page.next_version_marker = Some(text);
                }
                _ => {}
            },
            _ => {}
        }
    }
    if page.truncated && page.next_key_marker.is_none() {
        return None;
    }
    Some(page)
}

#[derive(Debug, Default)]
pub(crate) struct PrefixesPage {
    pub prefixes: Vec<String>,
    pub next_token: Option<String>,
}

/// ListObjectsV2 with a delimiter: the common prefixes, which are the folders.
pub(crate) fn prefixes_page(xml: &[u8]) -> Option<PrefixesPage> {
    let mut page = PrefixesPage::default();
    let mut truncated = false;
    for item in items(xml)? {
        if let Item::Text(parent, name, text) = item {
            match (parent.as_str(), name.as_str()) {
                ("CommonPrefixes", "Prefix") => page.prefixes.push(text),
                ("ListBucketResult", "IsTruncated") => truncated = text == "true",
                ("ListBucketResult", "NextContinuationToken") => page.next_token = Some(text),
                _ => {}
            }
        }
    }
    if truncated && page.next_token.is_none() {
        return None;
    }
    if !truncated {
        page.next_token = None;
    }
    Some(page)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_error_body_has_its_code_and_message() {
        let body = b"<?xml version=\"1.0\"?><Error><Code>SlowDown</Code><Message>Slow &amp; steady</Message><RequestId>1</RequestId></Error>";
        assert_eq!(
            error_body(body),
            Some(ErrorBody {
                code: "SlowDown".into(),
                message: "Slow & steady".into()
            })
        );
        assert_eq!(error_body(b"<html>nope</html>"), None);
        assert_eq!(error_body(b""), None);
    }

    #[test]
    fn versions_keep_the_document_order_with_delete_markers_between_them() {
        let body = br#"<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
            <Name>b</Name><IsTruncated>true</IsTruncated>
            <NextKeyMarker>a/2</NextKeyMarker><NextVersionIdMarker>v3</NextVersionIdMarker>
            <Version><Key>a/1</Key><VersionId>v4</VersionId><IsLatest>true</IsLatest>
              <LastModified>2026-11-11T00:00:04.000Z</LastModified><ETag>&quot;e4&quot;</ETag><Size>7</Size></Version>
            <DeleteMarker><Key>a/1</Key><VersionId>v3</VersionId><IsLatest>false</IsLatest>
              <LastModified>2026-11-11T00:00:03.000Z</LastModified></DeleteMarker>
            <Version><Key>a/1</Key><VersionId>v1</VersionId><LastModified>2026-11-11T00:00:01.000Z</LastModified>
              <ETag>&quot;e1&quot;</ETag><Size>3</Size></Version>
        </ListVersionsResult>"#;
        let page = versions_page(body).unwrap();
        assert!(page.truncated);
        assert_eq!(page.next_key_marker.as_deref(), Some("a/2"));
        assert_eq!(page.next_version_marker.as_deref(), Some("v3"));
        let seen: Vec<(&str, bool)> = page
            .entries
            .iter()
            .map(|e| (e.version_id.as_str(), e.is_delete_marker()))
            .collect();
        assert_eq!(seen, [("v4", false), ("v3", true), ("v1", false)]);
        assert_eq!(
            page.entries[0].content,
            Some(Content {
                etag: "\"e4\"".into(),
                size: 7
            })
        );
    }

    #[test]
    fn a_truncated_page_without_markers_is_unreadable() {
        let body = b"<ListVersionsResult><IsTruncated>true</IsTruncated></ListVersionsResult>";
        assert!(versions_page(body).is_none());
    }

    #[test]
    fn versioning_is_enabled_suspended_or_never_set() {
        let body = |status: &str| {
            format!(
                "<VersioningConfiguration xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">{status}</VersioningConfiguration>"
            )
        };
        assert_eq!(
            versioning_status(body("<Status>Enabled</Status>").as_bytes()),
            Some(Some("Enabled".into()))
        );
        assert_eq!(
            versioning_status(body("<Status>Suspended</Status>").as_bytes()),
            Some(Some("Suspended".into()))
        );
        assert_eq!(versioning_status(body("").as_bytes()), Some(None));
        assert_eq!(versioning_status(b"<VersioningConfiguration/>"), Some(None));
        assert_eq!(versioning_status(b"<Error><Code>x</Code></Error>"), None);
    }

    #[test]
    fn folders_are_the_common_prefixes() {
        let body = br#"<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t1</NextContinuationToken>
            <Contents><Key>ticketd/x</Key></Contents>
            <CommonPrefixes><Prefix>ticketd/one/</Prefix></CommonPrefixes>
            <CommonPrefixes><Prefix>ticketd/two/</Prefix></CommonPrefixes></ListBucketResult>"#;
        let page = prefixes_page(body).unwrap();
        assert_eq!(page.prefixes, ["ticketd/one/", "ticketd/two/"]);
        assert_eq!(page.next_token.as_deref(), Some("t1"));
    }
}
