//! Sync files: every ticket, Document, Plan, project, Automation and Automation
//! agent as one Markdown file with a YAML header, and back. The convention is recorded in `docs/sync-file-format.md`.
//!
//! One table of fields per block ([`shape`]) drives writing, parsing and validation,
//! so the three cannot drift apart. Applying a record writes only the fields that
//! differ from what the Workspace already holds.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{Connection, OptionalExtension, ToSql, params, types::ValueRef};
use saphyr::{LoadableYamlNode, Scalar, Yaml};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{Error, Status, Workspace, document_links, inbox::LOCAL_PERSON};

/// The record kinds that each have their own sync file, in an order that applies a
/// relationship's target before its owner where the kinds allow it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncKind {
    Project,
    Document,
    Plan,
    Ticket,
    /// Before Automations, whose steps name agents.
    AutomationAgent,
    Automation,
}

impl SyncKind {
    pub const ALL: [Self; 6] = [
        Self::Project,
        Self::Document,
        Self::Plan,
        Self::Ticket,
        Self::AutomationAgent,
        Self::Automation,
    ];

    /// The kind as a file's `kind` field and the sync tables spell it.
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Document => "document",
            Self::Plan => "plan",
            Self::Ticket => "ticket",
            Self::AutomationAgent => "automation_agent",
            Self::Automation => "automation",
        }
    }

    pub(crate) fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.name() == name)
    }

    /// The table holding the kind's records, which is also its folder of sync files.
    pub(crate) fn table(self) -> &'static str {
        match self {
            Self::Project => "projects",
            Self::Document => "documents",
            Self::Plan => "plans",
            Self::Ticket => "tickets",
            Self::AutomationAgent => "automation_agents",
            Self::Automation => "automations",
        }
    }
}

/// The largest file read or written as a record. A larger one in the storage
/// is skipped unread, and a larger record is not uploaded.
pub const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
/// How far into a header line list and key markers may reach. Every nested
/// list starts further right, so this bounds how deep a header nests; the
/// YAML reader bounds `[`-style nesting itself. ticketd writes two columns.
const MAX_HEADER_INDENT: usize = 64;

/// The format of sync files this version writes. A file that says a higher
/// number is left alone until this desktop runs a ticketd that reads it.
pub(crate) const FILE_FORMAT: i64 = 1;

/// The records kept as sections of their ticket's file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncPartKind {
    Activity,
    Evidence,
}

impl SyncPartKind {
    fn name(self) -> &'static str {
        match self {
            Self::Activity => "activity",
            Self::Evidence => "evidence",
        }
    }
}

/// One field of a sync file. An absent field, an empty set and a false flag mean the same.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncValue {
    /// A single value: text, a time, or the GUID of another record.
    Text(String),
    Flag(bool),
    /// Tags, or the GUIDs of related records.
    Set(BTreeSet<String>),
}

type Fields = BTreeMap<String, SyncValue>;

/// An Activity or Implementation evidence section of a ticket's file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncPart {
    pub kind: SyncPartKind,
    pub id: String,
    pub fields: Fields,
}

impl SyncPart {
    /// Sections are written oldest first; the GUID settles equal times the same way everywhere.
    pub(crate) fn order(&self) -> (SyncPartKind, &str, &str) {
        let time = match self.kind {
            SyncPartKind::Activity => "reported_at",
            SyncPartKind::Evidence => "created_at",
        };
        (self.kind, text(&self.fields, time).unwrap_or(""), &self.id)
    }
}

/// One synced record as the fields of its sync file. The Markdown text after the
/// header is the field `body`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncRecord {
    pub kind: SyncKind,
    pub id: String,
    pub fields: Fields,
    /// A ticket's Activities and Implementation evidence; empty for other kinds.
    pub parts: Vec<SyncPart>,
}

/// A relationship that was not applied because the record it names is not in this
/// Workspace yet. Applying the same record again after that record arrives completes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MissingTarget {
    pub field: String,
    pub id: String,
}

#[derive(Clone, Copy)]
enum Type {
    Text,
    /// Text that must not be blank.
    Name,
    Flag,
    Time,
    Id,
    Ids,
    /// A ticket: its GUID, or on input its Ticket reference.
    Ticket,
    Tickets,
    /// Items of `<GUID> <time>`: when each `blocked_by` relationship was made.
    Edges,
    /// Items of `<GUID>` or `<GUID> <time>`: relationships sync removed to break a loop.
    Removed,
    Tags,
    /// A list of text items in no order, such as the commands an agent may run.
    Texts,
    /// A whole number of at least 1.
    Count,
    Status,
    Reference,
    Choice(&'static [&'static str]),
}

/// Name, type, and whether the field is required.
type Field = (&'static str, Type, bool);

const TICKET: &[Field] = &[
    ("ref", Type::Reference, true),
    ("title", Type::Name, true),
    ("status", Type::Status, true),
    ("project", Type::Id, false),
    ("plan", Type::Id, false),
    ("parent", Type::Ticket, false),
    ("blocked_by", Type::Tickets, false),
    ("blocked_since", Type::Edges, false),
    ("blocked_by_removed", Type::Removed, false),
    ("parent_removed", Type::Removed, false),
    ("related", Type::Tickets, false),
    ("discovered", Type::Tickets, false),
    ("duplicate_of", Type::Ticket, false),
    ("duplicate_restore", Type::Status, false),
    ("tags", Type::Tags, false),
    ("documents", Type::Ids, false),
    ("attachments", Type::Ids, false),
    ("trashed", Type::Flag, false),
    ("following", Type::Flag, false),
    ("reminder", Type::Time, false),
    ("source_provider", Type::Name, false),
    ("source_external_id", Type::Name, false),
    ("source_locator", Type::Text, false),
    ("source_display", Type::Text, false),
    ("source_url", Type::Text, false),
    (
        "source_origin",
        Type::Choice(&["imported", "published"]),
        false,
    ),
    ("source_linked_at", Type::Time, false),
    (
        "source_authority",
        Type::Choice(&["external", "local"]),
        false,
    ),
    ("source_authority_changed_at", Type::Time, false),
    ("source_state", Type::Choice(&["open", "closed"]), false),
    (
        "source_closure_reason",
        Type::Choice(&["completed", "not_planned", "duplicate", "unknown"]),
        false,
    ),
    ("source_updated_at", Type::Text, false),
];
/// External-source provenance is stored and carried as a whole.
const SOURCE_REQUIRED: &[&str] = &[
    "source_provider",
    "source_external_id",
    "source_locator",
    "source_display",
    "source_url",
    "source_origin",
    "source_linked_at",
    "source_authority",
    "source_authority_changed_at",
    "source_state",
];
const DOCUMENT: &[Field] = &[
    ("title", Type::Text, false),
    ("created_at", Type::Time, true),
    ("tags", Type::Tags, false),
    ("origin_activity", Type::Id, false),
    ("trashed", Type::Flag, false),
    ("kept", Type::Flag, false),
    ("pinned", Type::Flag, false),
];
const PLAN: &[Field] = &[
    ("name", Type::Name, true),
    ("archived", Type::Flag, false),
    ("spec", Type::Id, false),
    ("documents", Type::Ids, false),
];
const PROJECT: &[Field] = &[("name", Type::Name, true)];
/// The text after the header is the agent's instructions.
const AUTOMATION_AGENT: &[Field] = &[
    ("name", Type::Text, false),
    ("harness", Type::Choice(&["claude-code", "codex"]), true),
    ("model", Type::Text, false),
    ("turn_limit", Type::Count, true),
    ("time_limit_minutes", Type::Count, true),
    ("read_files", Type::Flag, false),
    ("edit_files", Type::Flag, false),
    ("run_commands", Type::Flag, false),
    // A field of its own, so it merges as one value: two desktops that each
    // shorten `allowed_commands` to nothing never add up to "any command".
    ("any_command", Type::Flag, false),
    ("allowed_commands", Type::Texts, false),
    ("use_web", Type::Flag, false),
    ("trashed", Type::Flag, false),
];
/// The text after the header is the trigger, conditions and steps: one block of
/// JSON, because steps nest and a header does not. It is one field, so it merges
/// and goes to review as a whole.
const AUTOMATION: &[Field] = &[("name", Type::Text, false), ("trashed", Type::Flag, false)];
const ACTIVITY: &[Field] = &[
    ("reported_at", Type::Time, true),
    ("updated_at", Type::Time, true),
    ("agent", Type::Text, false),
    ("document", Type::Id, false),
];
const EVIDENCE: &[Field] = &[
    (
        "kind",
        Type::Choice(&[
            "pull_request",
            "commit",
            "branch",
            "worktree",
            "verification",
        ]),
        true,
    ),
    ("name", Type::Name, true),
    ("value", Type::Name, true),
    ("created_at", Type::Time, true),
    ("updated_at", Type::Time, true),
    ("agent", Type::Text, false),
];

/// A header with what follows it: a record, or a section of a ticket's file.
#[derive(Clone, Copy)]
enum Block {
    Record(SyncKind),
    Part(SyncPartKind),
}

impl Block {
    fn name(self) -> &'static str {
        match self {
            Self::Record(kind) => kind.name(),
            Self::Part(kind) => kind.name(),
        }
    }
}

/// The header fields of a block, and whether Markdown text follows its header.
fn shape(block: Block) -> (&'static [Field], bool) {
    match block {
        Block::Record(SyncKind::Ticket) => (TICKET, true),
        Block::Record(SyncKind::Document) => (DOCUMENT, true),
        Block::Record(SyncKind::Plan) => (PLAN, true),
        Block::Record(SyncKind::Project) => (PROJECT, false),
        Block::Record(SyncKind::AutomationAgent) => (AUTOMATION_AGENT, true),
        Block::Record(SyncKind::Automation) => (AUTOMATION, true),
        Block::Part(SyncPartKind::Activity) => (ACTIVITY, true),
        Block::Part(SyncPartKind::Evidence) => (EVIDENCE, false),
    }
}

/// A set-valued field stored as rows of `table`: `owner` is the record whose file
/// carries it and `member` the other side.
struct Relation {
    table: &'static str,
    owner: &'static str,
    member: &'static str,
    /// A column fixed to one value for this field.
    fixed: Option<(&'static str, &'static str)>,
    /// The table whose records the members name.
    target: &'static str,
}

fn relation(kind: SyncKind, field: &str) -> Option<Relation> {
    let (table, owner, member, fixed, target) = match (kind, field) {
        (SyncKind::Ticket, "blocked_by") => (
            "dependencies",
            "dependent_id",
            "blocker_id",
            None,
            "tickets",
        ),
        (SyncKind::Ticket, "related" | "discovered") => (
            "contextual_relationships",
            "source_id",
            "target_id",
            Some((
                "kind",
                if field == "related" {
                    "related"
                } else {
                    "discovered"
                },
            )),
            "tickets",
        ),
        (SyncKind::Ticket, "tags") => ("ticket_tags", "ticket_id", "tag_name", None, "tags"),
        (SyncKind::Ticket, "documents") => (
            "ticket_documents",
            "ticket_id",
            "document_id",
            None,
            "documents",
        ),
        (SyncKind::Ticket, "attachments") => (
            "ticket_attachments",
            "ticket_id",
            "attachment_id",
            None,
            "attachments",
        ),
        (SyncKind::Document, "tags") => ("document_tags", "document_id", "tag_name", None, "tags"),
        (SyncKind::Plan, "documents") => (
            "plan_documents",
            "plan_id",
            "document_id",
            None,
            "documents",
        ),
        _ => return None,
    };
    Some(Relation {
        table,
        owner,
        member,
        fixed,
        target,
    })
}

impl Relation {
    fn members(&self, c: &Connection, id: &str) -> Result<BTreeSet<String>, Error> {
        let fixed = self.fixed.map_or(String::new(), |(column, value)| {
            format!(" AND {column}='{value}'")
        });
        let mut statement = c.prepare(&format!(
            "SELECT {} FROM {} WHERE {}=?1{fixed}",
            self.member, self.table, self.owner
        ))?;
        Ok(statement
            .query_map([id], |row| row.get(0))?
            .collect::<Result<_, _>>()?)
    }

    fn replace(&self, c: &Connection, id: &str, wanted: &BTreeSet<String>) -> Result<(), Error> {
        let current = self.members(c, id)?;
        let (and_fixed, column, value) = match self.fixed {
            Some((column, value)) => (
                format!(" AND {column}='{value}'"),
                format!(", {column}"),
                format!(", '{value}'"),
            ),
            None => Default::default(),
        };
        for gone in current.difference(wanted) {
            c.execute(
                &format!(
                    "DELETE FROM {} WHERE {}=?1 AND {}=?2{and_fixed}",
                    self.table, self.owner, self.member
                ),
                params![id, gone],
            )?;
        }
        for new in wanted.difference(&current) {
            c.execute(
                &format!(
                    "INSERT INTO {} ({}, {}{column}) VALUES (?1, ?2{value})",
                    self.table, self.owner, self.member
                ),
                params![id, new],
            )?;
        }
        Ok(())
    }
}

fn bad(reason: impl Into<String>) -> Error {
    Error::SyncFile(reason.into())
}

fn text<'a>(fields: &'a Fields, name: &str) -> Option<&'a str> {
    match fields.get(name) {
        Some(SyncValue::Text(text)) => Some(text),
        _ => None,
    }
}

/// A `Count` field as the number it was checked to be.
fn count(fields: &Fields, name: &str) -> Option<u32> {
    text(fields, name)?.parse().ok()
}

fn set(fields: &Fields, name: &str) -> BTreeSet<String> {
    match fields.get(name) {
        Some(SyncValue::Set(members)) => members.clone(),
        _ => BTreeSet::new(),
    }
}

/// A field's value with the spellings of "nothing" folded together.
fn present<'a>(fields: &'a Fields, name: &str) -> Option<&'a SyncValue> {
    match fields.get(name) {
        Some(SyncValue::Flag(false)) => None,
        Some(SyncValue::Set(members)) if members.is_empty() => None,
        value => value,
    }
}

pub(crate) fn is_guid(text: &str) -> bool {
    Uuid::parse_str(text).is_ok_and(|id| id.to_string() == text)
}

fn names_ticket(text: &str) -> bool {
    is_guid(text) || document_links::is_ticket_reference(text)
}

/// A status as ticketd writes it, from a spelling that differs only in letter
/// case or in `-` or `_` for the space.
fn canonical_status(text: &str) -> Option<String> {
    let fold = |name: &str| name.trim().to_lowercase().replace(['-', '_'], " ");
    crate::Status::ALL
        .into_iter()
        .map(|status| status.to_string())
        .find(|name| fold(name) == fold(text))
}

/// The blocking ticket and the time of one `blocked_since` item.
fn edge_time(item: &str) -> Option<(&str, &str)> {
    item.split_once(' ')
        .filter(|(id, time)| is_guid(id) && chrono::DateTime::parse_from_rfc3339(time).is_ok())
}

/// A removed parent link that was removed before: `<GUID> <which removal>`.
fn removal_number(item: &str) -> bool {
    item.split_once(' ')
        .is_some_and(|(id, number)| is_guid(id) && number.parse::<u32>().is_ok())
}

fn expected(kind: Type) -> String {
    match kind {
        Type::Text => "text; put the value in quotes".into(),
        Type::Name => "text that is not blank".into(),
        Type::Flag => "true or false".into(),
        Type::Time => "a time such as \"2026-11-11T09:30:00Z\"".into(),
        Type::Id => "the id of a record: a lowercase GUID".into(),
        Type::Ids => "a list of record ids: lowercase GUIDs".into(),
        Type::Ticket => "a ticket: its id (a lowercase GUID) or its Ticket reference".into(),
        Type::Tickets => "a list of tickets: ids (lowercase GUIDs) or Ticket references".into(),
        Type::Tags => "a list of tags".into(),
        Type::Texts => "a list of text items; put each in quotes".into(),
        Type::Count => "a whole number of at least 1".into(),
        Type::Edges => {
            "a list of items such as \"<id of the blocking ticket> 2026-11-11T09:30:00Z\"".into()
        }
        Type::Removed => {
            "a list of items such as \"<id of a ticket>\" or \"<id of a ticket> 2026-11-11T09:30:00Z\"".into()
        }
        Type::Status => "one of Todo, In progress, In review, Done, Canceled, Duplicate".into(),
        Type::Reference => "a Ticket reference such as T-KQ43".into(),
        Type::Choice(options) => format!("one of {}", options.join(", ")),
    }
}

fn check(name: &str, kind: Type, value: &SyncValue) -> Result<(), Error> {
    let valid = match (kind, value) {
        (Type::Flag, SyncValue::Flag(_)) => true,
        (Type::Ids, SyncValue::Set(ids)) => ids.iter().all(|id| is_guid(id)),
        (Type::Tickets, SyncValue::Set(ids)) => ids.iter().all(|id| names_ticket(id)),
        (Type::Tags, SyncValue::Set(tags)) => tags
            .iter()
            .all(|tag| !tag.is_empty() && *tag == tag.trim().to_lowercase()),
        (Type::Edges, SyncValue::Set(edges)) => edges.iter().all(|edge| edge_time(edge).is_some()),
        (Type::Removed, SyncValue::Set(items)) => items
            .iter()
            .all(|item| is_guid(item) || edge_time(item).is_some() || removal_number(item)),
        (Type::Texts, SyncValue::Set(items)) => items.iter().all(|item| !item.trim().is_empty()),
        (
            Type::Flag
            | Type::Ids
            | Type::Tickets
            | Type::Tags
            | Type::Texts
            | Type::Edges
            | Type::Removed,
            _,
        )
        | (_, SyncValue::Flag(_) | SyncValue::Set(_)) => false,
        (Type::Count, SyncValue::Text(text)) => text.parse::<u32>().is_ok_and(|count| count > 0),
        (Type::Text, SyncValue::Text(_)) => true,
        (Type::Name, SyncValue::Text(text)) => !text.trim().is_empty(),
        (Type::Time, SyncValue::Text(text)) => chrono::DateTime::parse_from_rfc3339(text).is_ok(),
        (Type::Id, SyncValue::Text(text)) => is_guid(text),
        (Type::Ticket, SyncValue::Text(text)) => names_ticket(text),
        (Type::Status, SyncValue::Text(text)) => text.parse::<Status>().is_ok(),
        (Type::Reference, SyncValue::Text(text)) => document_links::is_ticket_reference(text),
        (Type::Choice(options), SyncValue::Text(text)) => options.contains(&text.as_str()),
    };
    if valid {
        Ok(())
    } else {
        Err(bad(format!("field '{name}' must be {}", expected(kind))))
    }
}

fn validate(block: Block, id: &str, fields: &Fields) -> Result<(), Error> {
    let (schema, has_body) = shape(block);
    let block = block.name();
    if !is_guid(id) {
        return Err(bad(format!(
            "field 'id' of a {block} must be {}",
            expected(Type::Id)
        )));
    }
    for (name, value) in fields {
        let kind = if name == "body" && has_body {
            Type::Text
        } else {
            schema
                .iter()
                .find(|field| field.0 == name)
                .ok_or_else(|| bad(format!("unknown field '{name}' in a {block}")))?
                .1
        };
        check(name, kind, value)?;
    }
    match schema
        .iter()
        .find(|field| field.2 && !fields.contains_key(field.0))
    {
        Some(field) => Err(bad(format!(
            "a {block} is missing its required field '{}'",
            field.0
        ))),
        None => Ok(()),
    }
}

/// A line of text that would read as file structure and is therefore written escaped.
fn structural(line: &str) -> bool {
    line.trim_start_matches('\\').starts_with("<!-- ticketd:")
}

/// A YAML double-quoted scalar. Everything YAML does not accept raw is escaped.
fn quote(text: &str) -> String {
    let mut quoted = String::from("\"");
    for character in text.chars() {
        match character {
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            c if c.is_control() || matches!(c, '\u{2028}' | '\u{2029}' | '\u{feff}') => {
                quoted.push_str(&format!("\\u{:04x}", u32::from(c)));
            }
            c => quoted.push(c),
        }
    }
    quoted.push('"');
    quoted
}

/// Ticket GUID to Ticket reference, written as a comment beside the GUID for readers.
type Labels = BTreeMap<String, String>;

fn write_block(out: &mut String, block: Block, id: &str, fields: &Fields, labels: &Labels) {
    let (schema, has_body) = shape(block);
    let quote = |text: &str| match labels.get(text) {
        Some(label) => format!("{} # {label}", quote(text)),
        None => quote(text),
    };
    out.push_str("---\n");
    if let Block::Record(kind) = block {
        out.push_str(&format!("kind: {}\nformat: {FILE_FORMAT}\n", kind.name()));
    }
    out.push_str(&format!("id: {}\n", quote(id)));
    for (name, kind, _) in schema {
        match fields.get(*name) {
            // Checked to be digits when the record was read.
            Some(SyncValue::Text(text)) if matches!(kind, Type::Count) => {
                out.push_str(&format!("{name}: {text}\n"));
            }
            Some(SyncValue::Text(text)) => out.push_str(&format!("{name}: {}\n", quote(text))),
            Some(SyncValue::Flag(flag)) => out.push_str(&format!("{name}: {flag}\n")),
            Some(SyncValue::Set(members)) if !members.is_empty() => {
                out.push_str(&format!("{name}:\n"));
                for member in members {
                    out.push_str(&format!("  - {}\n", quote(member)));
                }
            }
            Some(SyncValue::Set(_)) => {}
            None if matches!(kind, Type::Flag) => out.push_str(&format!("{name}: false\n")),
            None => {}
        }
    }
    out.push_str("---\n");
    if has_body {
        for line in text(fields, "body").unwrap_or("").split('\n') {
            if structural(line) {
                out.push('\\');
            }
            out.push_str(line);
            out.push('\n');
        }
    }
}

/// A header value before its field's type is known.
enum Raw {
    Null,
    Flag(bool),
    Integer(i64),
    Text(String),
    List(Vec<Raw>),
    Other,
}

fn raw(node: &Yaml<'_>) -> Raw {
    match node {
        Yaml::Value(Scalar::Null) => Raw::Null,
        Yaml::Value(Scalar::Boolean(flag)) => Raw::Flag(*flag),
        Yaml::Value(Scalar::Integer(number)) => Raw::Integer(*number),
        Yaml::Value(Scalar::String(text)) => Raw::Text(text.to_string()),
        Yaml::Sequence(items) => Raw::List(items.iter().map(raw).collect()),
        _ => Raw::Other,
    }
}

/// Split a block into its header entries and the text after the header.
fn read_block(block: &str) -> Result<(Vec<(String, Raw)>, String), Error> {
    let is_rule = |line: &str| line.trim_end_matches(['\r', '\n']) == "---";
    let mut lines = block.split_inclusive('\n');
    if !lines.next().is_some_and(is_rule) {
        return Err(bad(
            "a sync file and each of its sections must start with a '---' line",
        ));
    }
    let mut header = String::new();
    loop {
        match lines.next() {
            None => return Err(bad("a header has no closing '---' line")),
            Some(line) if is_rule(line) => break,
            // The values read from a header are walked and freed recursively.
            Some(line)
                if line
                    .bytes()
                    .take_while(|byte| matches!(byte, b' ' | b'-' | b'?'))
                    .count()
                    > MAX_HEADER_INDENT =>
            {
                return Err(bad("the header nests lists too deeply"));
            }
            Some(line) => header.push_str(line),
        }
    }
    let rest: String = lines.collect();
    let body = rest
        .strip_suffix('\n')
        .unwrap_or(&rest)
        .split('\n')
        .map(|line| match line.strip_prefix('\\') {
            Some(unescaped) if structural(line) => unescaped,
            _ => line,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let documents = Yaml::load_from_str(&header)
        .map_err(|error| bad(format!("the header is not valid YAML: {error}")))?;
    let mut entries = Vec::new();
    match documents.as_slice() {
        [] => {}
        [Yaml::Mapping(mapping)] => {
            for (key, value) in mapping {
                let Yaml::Value(Scalar::String(name)) = key else {
                    return Err(bad("the header has a field name that is not plain text"));
                };
                entries.push((name.to_string(), raw(value)));
            }
        }
        _ => return Err(bad("the header must be a list of 'field: value' lines")),
    }
    Ok((entries, body))
}

/// Give a block's header entries the types its fields have.
fn typed(
    block: Block,
    entries: Vec<(String, Raw)>,
    body: String,
) -> Result<(String, Fields), Error> {
    let (schema, has_body) = shape(block);
    let block = block.name();
    let mut id = None;
    let mut fields = Fields::new();
    for (name, value) in entries {
        if name == "id" {
            if let Raw::Text(text) = value {
                id = Some(text);
            }
            continue;
        }
        let kind = schema
            .iter()
            .find(|field| field.0 == name)
            .ok_or_else(|| bad(format!("unknown field '{name}' in a {block}")))?
            .1;
        let invalid = || bad(format!("field '{name}' must be {}", expected(kind)));
        let value = match (kind, value) {
            (_, Raw::Null) => continue,
            (Type::Flag, Raw::Flag(flag)) => SyncValue::Flag(flag),
            (
                Type::Ids | Type::Tickets | Type::Tags | Type::Texts | Type::Edges | Type::Removed,
                Raw::List(items),
            ) => {
                let mut members = BTreeSet::new();
                for item in items {
                    let Raw::Text(member) = item else {
                        return Err(invalid());
                    };
                    members.insert(if matches!(kind, Type::Tags) {
                        member.trim().to_lowercase()
                    } else {
                        member
                    });
                }
                SyncValue::Set(members)
            }
            (
                Type::Flag
                | Type::Ids
                | Type::Tickets
                | Type::Tags
                | Type::Texts
                | Type::Edges
                | Type::Removed,
                _,
            ) => {
                return Err(invalid());
            }
            (Type::Count, Raw::Integer(count)) => SyncValue::Text(count.to_string()),
            (Type::Status, Raw::Text(text)) => {
                SyncValue::Text(canonical_status(&text).unwrap_or(text))
            }
            (_, Raw::Text(text)) => SyncValue::Text(text),
            _ => {
                return Err(bad(format!(
                    "field '{name}' must be text; put the value in quotes"
                )));
            }
        };
        fields.insert(name, value);
    }
    for (name, kind, _) in schema {
        if matches!(kind, Type::Flag) {
            fields
                .entry((*name).to_owned())
                .or_insert(SyncValue::Flag(false));
        }
    }
    fields.retain(|_, value| !matches!(value, SyncValue::Set(members) if members.is_empty()));
    if has_body {
        fields.insert("body".into(), SyncValue::Text(body));
    } else if !body.trim().is_empty() {
        return Err(bad(format!("a {block} has no text after its header")));
    }
    let id = id.ok_or_else(|| bad(format!("a {block} is missing its required field 'id'")))?;
    Ok((id, fields))
}

/// A file's text cut at its section markers: the record's own block first.
fn blocks(file: &str) -> Result<Vec<(Option<SyncPartKind>, String)>, Error> {
    let file = file.strip_prefix('\u{feff}').unwrap_or(file);
    let mut blocks: Vec<(Option<SyncPartKind>, String)> = vec![(None, String::new())];
    for line in file.split_inclusive('\n') {
        match line.trim_end_matches(['\r', '\n']) {
            "<!-- ticketd:activity -->" => {
                blocks.push((Some(SyncPartKind::Activity), String::new()));
            }
            "<!-- ticketd:evidence -->" => {
                blocks.push((Some(SyncPartKind::Evidence), String::new()));
            }
            marker if marker.starts_with("<!-- ticketd:") => {
                return Err(bad(format!(
                    "unknown section marker '{marker}'; a text line that starts this way is written with a leading backslash"
                )));
            }
            _ => {
                if let Some((_, block)) = blocks.last_mut() {
                    block.push_str(line);
                }
            }
        }
    }
    Ok(blocks)
}

/// Whether a file that does not parse says a newer ticketd wrote it: its
/// format number is higher than this version reads. Such a file must not be
/// replaced by a desktop that cannot read it. The number is the only mark: a
/// field or section this version does not know, in a format it reads, is a
/// mistake made by hand like any other, and a later change here replaces it.
pub(crate) fn from_newer_version(file: &str) -> bool {
    let file = file.strip_prefix('\u{feff}').unwrap_or(file);
    // The record's own header, whatever sections follow it.
    let record: String = file
        .split_inclusive('\n')
        .take_while(|line| !line.starts_with("<!-- ticketd:"))
        .collect();
    read_block(&record).is_ok_and(|(entries, _)| {
        entries.iter().any(|(name, value)| {
            name == "format" && matches!(value, Raw::Integer(format) if *format > FILE_FORMAT)
        })
    })
}

/// The ticket a relationship names by GUID or by Ticket reference, if it is here.
fn ticket_id(c: &Connection, named: &str) -> Result<Option<String>, Error> {
    Ok(c.query_row(
        "SELECT id FROM tickets WHERE id = ?1 OR reference = ?1",
        [named],
        |row| row.get(0),
    )
    .optional()?)
}

/// Write each relationship that names a ticket of this Workspace by its Ticket
/// reference as that ticket's GUID. A reference no ticket here holds stays as
/// written, and applying the record reports it as a missing target.
pub(crate) fn resolve_ticket_references(
    c: &Connection,
    record: &mut SyncRecord,
) -> Result<(), Error> {
    if record.kind != SyncKind::Ticket {
        return Ok(());
    }
    for (name, kind, _) in TICKET {
        if !matches!(kind, Type::Ticket | Type::Tickets) {
            continue;
        }
        match record.fields.get_mut(*name) {
            Some(SyncValue::Text(named)) if !is_guid(named) => {
                if let Some(id) = ticket_id(c, named)? {
                    *named = id;
                }
            }
            Some(SyncValue::Set(members)) => {
                for named in std::mem::take(members) {
                    let id = if is_guid(&named) {
                        None
                    } else {
                        ticket_id(c, &named)?
                    };
                    members.insert(id.unwrap_or(named));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// The most characters of a record's readable file name, before `.md`.
const NAME_CHARS: usize = 80;

/// A title as a file name a file system or storage listing shows as typed:
/// characters they would not are dropped, each run of separators becomes one
/// space, and a long title is cut at a word, marked with an ellipsis.
fn readable_name(title: &str) -> String {
    let words: Vec<String> = title
        .split(|c: char| {
            matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
                || c.is_control()
                || c.is_whitespace()
        })
        .filter(|word| !word.is_empty())
        .map(str::to_owned)
        .collect();
    let name = words.join(" ");
    if name.chars().count() <= NAME_CHARS {
        return name;
    }
    // Room for the ellipsis; a single long word is cut mid-word.
    let cut: String = name.chars().take(NAME_CHARS - 1).collect();
    let next_is_space = name.chars().nth(NAME_CHARS - 1) == Some(' ');
    let kept = match cut.rfind(' ') {
        Some(at) if !next_is_space => &cut[..at],
        _ => cut.as_str(),
    };
    format!("{}…", kept.trim_end())
}

impl SyncRecord {
    /// A path for the record's file that never changes, by kind and GUID. The
    /// storage does not use it: there a file carries a readable name
    /// ([`SyncRecord::display_name`]) and is found by its GUID.
    pub fn path(&self) -> String {
        format!("{}/{}.md", self.kind.table(), self.id)
    }

    /// The record's file text. The same record always gives the same bytes.
    pub fn to_markdown(&self) -> String {
        self.to_text(&Labels::new())
    }

    fn to_text(&self, labels: &Labels) -> String {
        let mut out = String::new();
        let block = Block::Record(self.kind);
        write_block(&mut out, block, &self.id, &self.fields, labels);
        let mut parts: Vec<&SyncPart> = self.parts.iter().collect();
        parts.sort_by(|a, b| a.order().cmp(&b.order()));
        for part in parts {
            out.push_str(&format!("<!-- ticketd:{} -->\n", part.kind.name()));
            let block = Block::Part(part.kind);
            write_block(&mut out, block, &part.id, &part.fields, labels);
        }
        out
    }

    /// A readable name for the record's file: the Ticket reference and title, or the
    /// title or name of another record. It is never an identity and may repeat.
    pub fn display_name(&self) -> String {
        let field = |name| text(&self.fields, name).unwrap_or_default();
        let name = match self.kind {
            SyncKind::Ticket => format!("{} {}", field("ref"), field("title")),
            SyncKind::Document => field("title").to_owned(),
            SyncKind::Plan
            | SyncKind::Project
            | SyncKind::AutomationAgent
            | SyncKind::Automation => field("name").to_owned(),
        };
        match readable_name(&name).as_str() {
            "" => "Untitled.md".to_owned(),
            name => format!("{name}.md"),
        }
    }

    /// Read and validate a file's text. Nothing is read from or written to a Workspace.
    pub fn parse(file: &str) -> Result<Self, Error> {
        let mut record = None;
        for (part, block) in blocks(file)? {
            let (mut entries, body) = read_block(&block)?;
            match (part, &mut record) {
                (Some(kind), Some(SyncRecord { parts, .. })) => {
                    let (id, fields) = typed(Block::Part(kind), entries, body)?;
                    parts.push(SyncPart { kind, id, fields });
                }
                _ => {
                    let mut take = |field: &str| {
                        entries
                            .iter()
                            .position(|(name, _)| name == field)
                            .map(|at| entries.remove(at).1)
                    };
                    let kind = match take("kind") {
                        Some(Raw::Text(name)) => SyncKind::parse(&name),
                        _ => None,
                    }
                    .ok_or_else(|| {
                        bad("field 'kind' must be one of project, document, plan, ticket, automation_agent, automation")
                    })?;
                    match take("format") {
                        // Files from before the marker are format 1.
                        None | Some(Raw::Null) => {}
                        Some(Raw::Integer(format)) if (1..=FILE_FORMAT).contains(&format) => {}
                        Some(Raw::Integer(format)) if format > FILE_FORMAT => {
                            return Err(bad(format!(
                                "the file is in format {format}, which a newer ticketd wrote; update ticketd on this desktop to read it"
                            )));
                        }
                        Some(_) => return Err(bad("field 'format' must be a whole number")),
                    }
                    let (id, fields) = typed(Block::Record(kind), entries, body)?;
                    record = Some(SyncRecord {
                        kind,
                        id,
                        fields,
                        parts: Vec::new(),
                    });
                }
            }
        }
        let mut record = record.ok_or_else(|| bad("a sync file must start with a '---' line"))?;
        record.parts.sort_by(|a, b| a.order().cmp(&b.order()));
        record.validate()?;
        Ok(record)
    }

    /// Check a record built or merged in code the way a parsed file is checked.
    pub fn validate(&self) -> Result<(), Error> {
        validate(Block::Record(self.kind), &self.id, &self.fields)?;
        let mut seen = BTreeSet::new();
        for part in &self.parts {
            if self.kind != SyncKind::Ticket {
                return Err(bad("only a ticket has Activity and evidence sections"));
            }
            validate(Block::Part(part.kind), &part.id, &part.fields)?;
            if !seen.insert(&part.id) {
                return Err(bad(format!("section id '{}' is used twice", part.id)));
            }
            if part.kind == SyncPartKind::Activity
                && crate::activities::is_blank_brief(text(&part.fields, "body").unwrap_or(""))
            {
                return Err(bad(format!("Activity '{}' has no brief", part.id)));
            }
        }
        if self.kind == SyncKind::Automation {
            crate::automations::from_file_body(text(&self.fields, "body").unwrap_or(""))?;
        }
        if self.kind != SyncKind::Ticket {
            return Ok(());
        }
        let own = |other: &str| other == self.id || Some(other) == text(&self.fields, "ref");
        for name in ["parent", "duplicate_of"] {
            if text(&self.fields, name).is_some_and(own) {
                return Err(bad(format!("field '{name}' must name another ticket")));
            }
        }
        for name in ["blocked_by", "related", "discovered"] {
            if set(&self.fields, name).iter().any(|other| own(other)) {
                return Err(bad(format!("field '{name}' must name other tickets")));
            }
        }
        // Related is symmetric, so only one of the two files may carry it.
        if set(&self.fields, "related")
            .iter()
            .any(|other| is_guid(other) && *other < self.id)
        {
            return Err(bad(
                "field 'related' lists only tickets whose id sorts after this one; the other ticket's file carries the rest",
            ));
        }
        let sourced = self.fields.keys().any(|name| name.starts_with("source_"));
        match SOURCE_REQUIRED
            .iter()
            .find(|name| sourced && !self.fields.contains_key(**name))
        {
            Some(name) => Err(bad(format!(
                "the source_ fields go together; '{name}' is missing"
            ))),
            None => Ok(()),
        }
    }
}

/// Rows of a query by one id, as fields named by `names`. NULL leaves a field out,
/// an integer is a flag and anything else is text.
fn rows(c: &Connection, sql: &str, id: &str, names: &[&str]) -> Result<Vec<Fields>, Error> {
    let mut statement = c.prepare(sql)?;
    let mut rows = statement.query([id])?;
    let mut found = Vec::new();
    while let Some(row) = rows.next()? {
        let mut fields = Fields::new();
        for (index, name) in names.iter().enumerate() {
            let value = match row.get_ref(index)? {
                ValueRef::Null => continue,
                ValueRef::Integer(flag) => SyncValue::Flag(flag != 0),
                _ => SyncValue::Text(row.get(index)?),
            };
            fields.insert((*name).to_owned(), value);
        }
        found.push(fields);
    }
    Ok(found)
}

const SOURCE_SQL: &str = "SELECT i.provider, i.external_id, i.locator, i.display, i.url, i.origin, i.linked_at, o.authority, o.changed_at, s.external_state, s.closure_reason, s.external_updated_at FROM external_identities i JOIN external_ownership o ON o.ticket_id = i.ticket_id JOIN source_sync s ON s.ticket_id = i.ticket_id WHERE i.ticket_id = ?1";
const SOURCE_NAMES: &[&str] = &[
    "source_provider",
    "source_external_id",
    "source_locator",
    "source_display",
    "source_url",
    "source_origin",
    "source_linked_at",
    "source_authority",
    "source_authority_changed_at",
    "source_state",
    "source_closure_reason",
    "source_updated_at",
];

fn read_record(c: &Connection, kind: SyncKind, id: &str) -> Result<Option<SyncRecord>, Error> {
    let follows = format!(
        "SELECT reference, title, status, body, project_id, plan_id, trashed, EXISTS(SELECT 1 FROM ticket_follows WHERE ticket_id = t.id AND person = '{LOCAL_PERSON}') FROM tickets t WHERE id = ?1"
    );
    let reminder = format!(
        "SELECT due_at FROM ticket_reminders WHERE ticket_id = ?1 AND person = '{LOCAL_PERSON}'"
    );
    let queries: &[(&str, &[&str])] = match kind {
        SyncKind::Project => &[("SELECT name FROM projects WHERE id = ?1", &["name"])],
        SyncKind::Document => &[(
            "SELECT title, body, created_at, originating_activity_id, trashed, kept, EXISTS(SELECT 1 FROM document_pins WHERE document_id = d.id) FROM documents d WHERE id = ?1",
            &[
                "title",
                "body",
                "created_at",
                "origin_activity",
                "trashed",
                "kept",
                "pinned",
            ],
        )],
        SyncKind::Plan => &[(
            "SELECT name, purpose, archived, spec_document_id FROM plans WHERE id = ?1",
            &["name", "body", "archived", "spec"],
        )],
        SyncKind::AutomationAgent => &[(
            "SELECT name, harness, model, CAST(turn_limit AS TEXT), CAST(time_limit_minutes AS TEXT), read_files, edit_files, run_commands, any_command, allowed_commands, use_web, instructions, trashed FROM automation_agents WHERE id = ?1",
            &[
                "name",
                "harness",
                "model",
                "turn_limit",
                "time_limit_minutes",
                "read_files",
                "edit_files",
                "run_commands",
                "any_command",
                "allowed_commands",
                "use_web",
                "body",
                "trashed",
            ],
        )],
        SyncKind::Automation => &[(
            "SELECT name, definition, trashed FROM automations WHERE id = ?1",
            &["name", "body", "trashed"],
        )],
        SyncKind::Ticket => &[
            (
                &follows,
                &[
                    "ref",
                    "title",
                    "status",
                    "body",
                    "project",
                    "plan",
                    "trashed",
                    "following",
                ],
            ),
            (
                "SELECT parent_id FROM ticket_parents WHERE child_id = ?1",
                &["parent"],
            ),
            (
                "SELECT canonical_id, restore_status FROM duplicate_tickets WHERE source_id = ?1",
                &["duplicate_of", "duplicate_restore"],
            ),
            (&reminder, &["reminder"]),
            (SOURCE_SQL, SOURCE_NAMES),
        ],
    };
    let mut fields = Fields::new();
    for (index, (sql, names)) in queries.iter().enumerate() {
        match rows(c, sql, id, names)?.pop() {
            Some(row) => fields.extend(row),
            // The first query reads the record's own row.
            None if index == 0 => return Ok(None),
            None => {}
        }
    }
    for (name, _, _) in shape(Block::Record(kind)).0 {
        if let Some(relation) = relation(kind, name) {
            let members = relation.members(c, id)?;
            if !members.is_empty() {
                fields.insert((*name).to_owned(), SyncValue::Set(members));
            }
        }
    }
    // The two columns stored as JSON are written for a reader.
    match kind {
        SyncKind::AutomationAgent => {
            let commands: BTreeSet<String> =
                serde_json::from_str(text(&fields, "allowed_commands").unwrap_or("[]"))
                    .map_err(|error| Error::InvalidAutomationAgent(error.to_string()))?;
            fields.remove("allowed_commands");
            if !commands.is_empty() {
                fields.insert("allowed_commands".into(), SyncValue::Set(commands));
            }
        }
        SyncKind::Automation => {
            let body = crate::automations::file_body(text(&fields, "body").unwrap_or(""))?;
            fields.insert("body".into(), SyncValue::Text(body));
        }
        SyncKind::Project | SyncKind::Document | SyncKind::Plan | SyncKind::Ticket => {}
    }
    let mut parts = Vec::new();
    if kind == SyncKind::Ticket {
        let mut statement = c.prepare(
            "SELECT blocker_id || ' ' || created_at FROM dependencies WHERE dependent_id = ?1 AND created_at != ''",
        )?;
        let since: BTreeSet<String> = statement
            .query_map([id], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        if !since.is_empty() {
            fields.insert("blocked_since".into(), SyncValue::Set(since));
        }
        // Kept as this desktop's notices, so each removal is recorded once here.
        for (name, removed) in crate::sync::removed_by_sync(c, id)? {
            if !removed.is_empty() {
                fields.insert(name.into(), SyncValue::Set(removed));
            }
        }
        let sections: [(SyncPartKind, &str, &[&str]); 2] = [
            (
                SyncPartKind::Activity,
                "SELECT id, reported_at, updated_at, editing_agent, supporting_document_id, brief FROM activities WHERE ticket_id = ?1",
                &[
                    "id",
                    "reported_at",
                    "updated_at",
                    "agent",
                    "document",
                    "body",
                ],
            ),
            (
                SyncPartKind::Evidence,
                "SELECT id, kind, name, value, created_at, updated_at, editing_agent FROM evidence WHERE ticket_id = ?1",
                &[
                    "id",
                    "kind",
                    "name",
                    "value",
                    "created_at",
                    "updated_at",
                    "agent",
                ],
            ),
        ];
        for (kind, sql, names) in sections {
            for mut fields in rows(c, sql, id, names)? {
                if let Some(SyncValue::Text(id)) = fields.remove("id") {
                    parts.push(SyncPart { kind, id, fields });
                }
            }
        }
        parts.sort_by(|a, b| a.order().cmp(&b.order()));
    }
    Ok(Some(SyncRecord {
        kind,
        id: id.to_owned(),
        fields,
        parts,
    }))
}

fn exists(c: &Connection, table: &str, id: &str) -> Result<bool, Error> {
    Ok(c.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id = ?1)"),
        [id],
        |row| row.get(0),
    )?)
}

fn put(
    c: &Connection,
    table: &str,
    column: &str,
    id: &str,
    value: &dyn ToSql,
) -> Result<(), Error> {
    c.execute(
        &format!("UPDATE {table} SET {column} = ?2 WHERE id = ?1"),
        params![id, value],
    )?;
    Ok(())
}

const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/// Writes of one record. Relationships whose target is not here yet collect in `missing`.
struct Apply<'a> {
    c: &'a Connection,
    record: &'a SyncRecord,
    missing: Vec<MissingTarget>,
}

impl Apply<'_> {
    /// The single record a field names: `Some(None)` clears it, and `None` means the
    /// record has not arrived, so what the Workspace holds is left alone.
    fn target(&mut self, field: &str, table: &str) -> Result<Option<Option<String>>, Error> {
        let Some(id) = text(&self.record.fields, field) else {
            return Ok(Some(None));
        };
        if table == "tickets" {
            if let Some(ticket) = ticket_id(self.c, id)? {
                return Ok(Some(Some(ticket)));
            }
        } else if exists(self.c, table, id)? {
            return Ok(Some(Some(id.to_owned())));
        }
        self.missing.push(MissingTarget {
            field: field.to_owned(),
            id: id.to_owned(),
        });
        Ok(None)
    }

    fn create(&self) -> Result<(), Error> {
        let (c, id, fields) = (self.c, &self.record.id, &self.record.fields);
        match self.record.kind {
            SyncKind::Project => {
                // The checkout folder is device-local and is chosen on each device.
                c.execute(
                    "INSERT INTO projects (id, name, path) VALUES (?1, ?2, '')",
                    params![id, text(fields, "name")],
                )?;
            }
            SyncKind::Document => {
                c.execute(
                    "INSERT INTO entities (id, kind) VALUES (?1, 'document')",
                    [id],
                )?;
                c.execute(
                    "INSERT INTO documents (id, body, created_at) VALUES (?1, '', ?2)",
                    params![id, text(fields, "created_at")],
                )?;
            }
            SyncKind::Plan => {
                c.execute(
                    "INSERT INTO plans (id, name) VALUES (?1, ?2)",
                    params![id, text(fields, "name")],
                )?;
            }
            SyncKind::Ticket => {
                let reference = text(fields, "ref");
                if c.query_row(
                    "SELECT EXISTS(SELECT 1 FROM tickets WHERE reference = ?1)",
                    [reference],
                    |row| row.get(0),
                )? {
                    return Err(bad(format!(
                        "reference {} already belongs to another ticket in this Workspace",
                        reference.unwrap_or_default()
                    )));
                }
                // The file carries the reference its own device issued; this device's
                // counter is not used.
                c.execute(
                    "INSERT INTO tickets (id, reference, title, status) VALUES (?1, ?2, ?3, 'Todo')",
                    params![id, reference, text(fields, "title")],
                )?;
            }
            SyncKind::AutomationAgent => {
                // Every field differs from these or is written next.
                c.execute(
                    "INSERT INTO automation_agents (id, name, harness, instructions, read_files, edit_files, run_commands, allowed_commands, use_web, turn_limit, time_limit_minutes) VALUES (?1, '', ?2, '', 0, 0, 0, '[]', 0, ?3, ?4)",
                    params![
                        id,
                        text(fields, "harness"),
                        count(fields, "turn_limit"),
                        count(fields, "time_limit_minutes")
                    ],
                )?;
            }
            SyncKind::Automation => crate::automations::create_arrived(c, id)?,
        }
        Ok(())
    }

    fn write(&mut self, field: &str) -> Result<(), Error> {
        let (c, record) = (self.c, self.record);
        let (id, fields, table) = (record.id.as_str(), &record.fields, record.kind.table());
        let value = text(fields, field);
        let flag = matches!(fields.get(field), Some(SyncValue::Flag(true)));
        if let Some(relation) = relation(record.kind, field) {
            let mut wanted = set(fields, field);
            if relation.target == "tags" {
                for tag in &wanted {
                    c.execute("INSERT OR IGNORE INTO tags (name) VALUES (?1)", [tag])?;
                }
            } else {
                for member in std::mem::take(&mut wanted) {
                    let found = if relation.target == "tickets" {
                        ticket_id(c, &member)?
                    } else {
                        exists(c, relation.target, &member)?.then(|| member.clone())
                    };
                    if let Some(found) = found {
                        wanted.insert(found);
                    } else {
                        self.missing.push(MissingTarget {
                            field: field.to_owned(),
                            id: member,
                        });
                    }
                }
            }
            relation.replace(c, id, &wanted)?;
            if field == "blocked_by" {
                self.write_edge_times()?;
            }
            return Ok(());
        }
        match (record.kind, field) {
            (SyncKind::Ticket, "blocked_since") => self.write_edge_times()?,
            (SyncKind::Ticket, "ref") => {
                return Err(bad(format!(
                    "ticket {id} has another reference in this Workspace; a reference never changes"
                )));
            }
            (SyncKind::Document, "title" | "body") => {
                // The time of the last content change is this device's own, and it
                // tells an open editor that the Document moved under it.
                c.execute(
                    &format!("UPDATE documents SET {field} = ?2, updated_at = {NOW} WHERE id = ?1"),
                    params![id, value],
                )?;
            }
            (SyncKind::AutomationAgent, "body") => {
                put(c, table, "instructions", id, &value.unwrap_or(""))?;
            }
            (SyncKind::AutomationAgent, "model") => {
                put(
                    c,
                    table,
                    field,
                    id,
                    &value.filter(|model| !model.is_empty()),
                )?;
            }
            (SyncKind::AutomationAgent, "harness") => put(c, table, field, id, &value)?,
            (SyncKind::AutomationAgent, "turn_limit" | "time_limit_minutes") => {
                put(c, table, field, id, &count(fields, field))?;
            }
            (
                SyncKind::AutomationAgent,
                "read_files" | "edit_files" | "run_commands" | "any_command" | "use_web",
            ) => {
                put(c, table, field, id, &flag)?;
            }
            (SyncKind::AutomationAgent, "allowed_commands") => {
                let commands = serde_json::to_string(&set(fields, field))
                    .map_err(|error| bad(error.to_string()))?;
                put(c, table, field, id, &commands)?;
            }
            (SyncKind::Automation, "body") => {
                let definition = crate::automations::from_file_body(value.unwrap_or(""))?;
                crate::automations::restart_schedule_if_trigger_changes(c, id, &definition)?;
                put(c, table, "definition", id, &definition)?;
            }
            // Neither needs a name.
            (SyncKind::AutomationAgent | SyncKind::Automation, "name") => {
                put(c, table, field, id, &value.unwrap_or(""))?;
            }
            (SyncKind::Ticket, "body") => put(c, table, field, id, &value.unwrap_or(""))?,
            (SyncKind::Plan, "body") => put(c, table, "purpose", id, &value.unwrap_or(""))?,
            (_, "name" | "title" | "status" | "created_at") => put(c, table, field, id, &value)?,
            (_, "trashed" | "kept" | "archived") => put(c, table, field, id, &flag)?,
            (SyncKind::Document, "pinned") => {
                c.execute(
                    if flag {
                        "INSERT OR IGNORE INTO document_pins (document_id) VALUES (?1)"
                    } else {
                        "DELETE FROM document_pins WHERE document_id = ?1"
                    },
                    [id],
                )?;
            }
            (SyncKind::Document, "origin_activity") => {
                if let Some(activity) = self.target(field, "activities")? {
                    put(c, table, "originating_activity_id", id, &activity)?;
                }
            }
            (SyncKind::Plan, "spec") => {
                if let Some(document) = self.target(field, "documents")? {
                    put(c, table, "spec_document_id", id, &document)?;
                }
            }
            (SyncKind::Ticket, "project") => {
                if let Some(project) = self.target(field, "projects")? {
                    put(c, table, "project_id", id, &project)?;
                }
            }
            (SyncKind::Ticket, "plan") => {
                if let Some(plan) = self.target(field, "plans")? {
                    put(c, table, "plan_id", id, &plan)?;
                }
            }
            (SyncKind::Ticket, "parent") => match self.target(field, "tickets")? {
                Some(Some(parent)) => {
                    c.execute("INSERT INTO ticket_parents (child_id, parent_id) VALUES (?1, ?2) ON CONFLICT(child_id) DO UPDATE SET parent_id = excluded.parent_id", params![id, parent])?;
                }
                Some(None) => {
                    c.execute("DELETE FROM ticket_parents WHERE child_id = ?1", [id])?;
                }
                None => {}
            },
            (SyncKind::Ticket, "duplicate_of" | "duplicate_restore") => {
                match self.target("duplicate_of", "tickets")? {
                    Some(Some(canonical)) => {
                        c.execute("INSERT INTO duplicate_tickets (source_id, canonical_id, restore_status) VALUES (?1, ?2, ?3) ON CONFLICT(source_id) DO UPDATE SET canonical_id = excluded.canonical_id, restore_status = excluded.restore_status", params![id, canonical, text(fields, "duplicate_restore")])?;
                    }
                    Some(None) => {
                        c.execute("DELETE FROM duplicate_tickets WHERE source_id = ?1", [id])?;
                    }
                    None => {}
                }
            }
            (SyncKind::Ticket, "following") => {
                c.execute(
                    if flag {
                        "INSERT OR IGNORE INTO ticket_follows (ticket_id, person) VALUES (?1, ?2)"
                    } else {
                        "DELETE FROM ticket_follows WHERE ticket_id = ?1 AND person = ?2"
                    },
                    params![id, LOCAL_PERSON],
                )?;
            }
            (SyncKind::Ticket, "reminder") => match value {
                // A changed time is a new occurrence, as when it is set on this device.
                Some(due) => {
                    c.execute("INSERT INTO ticket_reminders (person, ticket_id, due_at, delivered) VALUES (?2, ?1, ?3, 0) ON CONFLICT(person, ticket_id) DO UPDATE SET due_at = excluded.due_at, delivered = 0", params![id, LOCAL_PERSON, due])?;
                }
                None => {
                    c.execute(
                        "DELETE FROM ticket_reminders WHERE ticket_id = ?1 AND person = ?2",
                        params![id, LOCAL_PERSON],
                    )?;
                }
            },
            (SyncKind::Ticket, _) if field.starts_with("source_") => self.write_source()?,
            _ => {}
        }
        if field == "body" && matches!(record.kind, SyncKind::Ticket | SyncKind::Document) {
            // Links to files that have not arrived must not make the text unreadable.
            document_links::index_external_body(c, id, value.unwrap_or(""))?;
        }
        Ok(())
    }

    /// Give each dependency the time its file carries, so every device orders the
    /// edges alike; the earliest wins when devices added the same edge separately.
    fn write_edge_times(&self) -> Result<(), Error> {
        let mut times: BTreeMap<&str, &str> = BTreeMap::new();
        let since = set(&self.record.fields, "blocked_since");
        // Items sort by GUID then time, so the first one seen for a GUID is its earliest.
        for (blocker, time) in since.iter().filter_map(|item| edge_time(item)) {
            times.entry(blocker).or_insert(time);
        }
        let mut statement = self
            .c
            .prepare("SELECT blocker_id FROM dependencies WHERE dependent_id = ?1")?;
        let blockers = statement
            .query_map([&self.record.id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        for blocker in blockers {
            let time = times.get(blocker.as_str()).copied().unwrap_or("");
            self.c.execute(
                "UPDATE dependencies SET created_at = ?3 WHERE dependent_id = ?1 AND blocker_id = ?2 AND created_at IS NOT ?3",
                params![self.record.id, blocker, time],
            )?;
        }
        Ok(())
    }

    /// Provenance, authority and the external state last seen. When and how this
    /// device last refreshed from the source stays its own.
    fn write_source(&self) -> Result<(), Error> {
        let (c, id) = (self.c, &self.record.id);
        let values: Vec<Option<&str>> = SOURCE_NAMES
            .iter()
            .map(|name| text(&self.record.fields, name))
            .collect();
        if values[0].is_none() {
            c.execute("DELETE FROM source_sync WHERE ticket_id = ?1", [id])?;
            c.execute("DELETE FROM external_ownership WHERE ticket_id = ?1", [id])?;
            c.execute("DELETE FROM external_identities WHERE ticket_id = ?1", [id])?;
            return Ok(());
        }
        c.execute("INSERT INTO external_identities (ticket_id, provider, external_id, locator, display, url, origin, linked_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(ticket_id) DO UPDATE SET provider = excluded.provider, external_id = excluded.external_id, locator = excluded.locator, display = excluded.display, url = excluded.url, origin = excluded.origin, linked_at = excluded.linked_at",
            params![id, values[0], values[1], values[2], values[3], values[4], values[5], values[6]])?;
        c.execute("INSERT INTO external_ownership (ticket_id, authority, changed_at) VALUES (?1, ?2, ?3) ON CONFLICT(ticket_id) DO UPDATE SET authority = excluded.authority, changed_at = excluded.changed_at",
            params![id, values[7], values[8]])?;
        c.execute("INSERT INTO source_sync (ticket_id, external_state, closure_reason, external_updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(ticket_id) DO UPDATE SET external_state = excluded.external_state, closure_reason = excluded.closure_reason, external_updated_at = excluded.external_updated_at",
            params![id, values[9], values[10], values[11].unwrap_or("")])?;
        Ok(())
    }

    fn write_part(&mut self, part: &SyncPart, current: Option<&SyncPart>) -> Result<(), Error> {
        let (c, ticket) = (self.c, &self.record.id);
        let table = match part.kind {
            SyncPartKind::Activity => "activities",
            SyncPartKind::Evidence => "evidence",
        };
        let owner: Option<String> = c
            .query_row(
                &format!("SELECT ticket_id FROM {table} WHERE id = ?1"),
                [&part.id],
                |row| row.get(0),
            )
            .optional()?;
        if owner.is_some_and(|owner| owner != *ticket) {
            return Err(bad(format!(
                "section '{}' already belongs to another ticket in this Workspace",
                part.id
            )));
        }
        let field = |name: &str| text(&part.fields, name);
        match part.kind {
            SyncPartKind::Activity => {
                let document = match field("document") {
                    Some(document) if !exists(c, "documents", document)? => {
                        self.missing.push(MissingTarget {
                            field: "document".into(),
                            id: document.to_owned(),
                        });
                        current.and_then(|current| text(&current.fields, "document"))
                    }
                    document => document,
                };
                let brief = field("body").unwrap_or("");
                c.execute("INSERT INTO activities (id, ticket_id, brief, reported_at, updated_at, editing_agent, supporting_document_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(id) DO UPDATE SET brief = excluded.brief, reported_at = excluded.reported_at, updated_at = excluded.updated_at, editing_agent = excluded.editing_agent, supporting_document_id = excluded.supporting_document_id",
                    params![part.id, ticket, brief, field("reported_at"), field("updated_at"), field("agent"), document])?;
                document_links::index_external_activity(c, &part.id, brief)?;
            }
            SyncPartKind::Evidence => {
                c.execute("INSERT INTO evidence (id, ticket_id, kind, name, value, created_at, updated_at, editing_agent) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, name = excluded.name, value = excluded.value, created_at = excluded.created_at, updated_at = excluded.updated_at, editing_agent = excluded.editing_agent",
                    params![part.id, ticket, field("kind"), field("name"), field("value"), field("created_at"), field("updated_at"), field("agent")])?;
            }
        }
        Ok(())
    }

    fn run(&mut self) -> Result<(), Error> {
        let (c, record) = (self.c, self.record);
        let (current, created) = match read_record(c, record.kind, &record.id)? {
            Some(current) => (current, false),
            None => {
                self.create()?;
                let created = read_record(c, record.kind, &record.id)?
                    .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
                (created, true)
            }
        };
        let (schema, _) = shape(Block::Record(record.kind));
        for name in schema.iter().map(|field| field.0).chain(["body"]) {
            if present(&current.fields, name) != present(&record.fields, name) {
                self.write(name)?;
            }
        }
        for gone in &current.parts {
            if !record.parts.iter().any(|part| part.id == gone.id) {
                let table = match gone.kind {
                    SyncPartKind::Activity => "activities",
                    SyncPartKind::Evidence => "evidence",
                };
                c.execute(&format!("DELETE FROM {table} WHERE id = ?1"), [&gone.id])?;
            }
        }
        for part in &record.parts {
            let current = current.parts.iter().find(|current| current.id == part.id);
            if current != Some(part) {
                self.write_part(part, current)?;
            }
        }
        if created {
            // Text that arrived earlier may link to this record; its links resolve now.
            match record.kind {
                SyncKind::Ticket => {
                    reindex_mentions(c, text(&record.fields, "ref").unwrap_or_default())?;
                }
                SyncKind::Document | SyncKind::Plan => reindex_mentions(c, &record.id)?,
                SyncKind::Project | SyncKind::AutomationAgent | SyncKind::Automation => {}
            }
        }
        if matches!(
            record.kind,
            SyncKind::AutomationAgent | SyncKind::Automation
        ) {
            crate::automations::switch_off_unfinished(c)?;
        }
        Ok(())
    }
}

// ponytail: scans every body once per newly arrived record; keep an index of
// unresolved link targets if a first download of a large Workspace gets slow.
fn reindex_mentions(c: &Connection, needle: &str) -> Result<(), Error> {
    for (sql, activity) in [
        (
            "SELECT id, body FROM tickets WHERE instr(body, ?1) > 0",
            false,
        ),
        (
            "SELECT id, body FROM documents WHERE instr(body, ?1) > 0",
            false,
        ),
        (
            "SELECT id, brief FROM activities WHERE instr(brief, ?1) > 0",
            true,
        ),
    ] {
        let mut statement = c.prepare(sql)?;
        let sources = statement
            .query_map([needle], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for (id, body) in sources {
            if activity {
                document_links::index_external_activity(c, &id, &body)?;
            } else {
                document_links::index_external_body(c, &id, &body)?;
            }
        }
    }
    Ok(())
}

impl Workspace {
    /// The GUID of every record of a kind, including trashed ones, in a stable order.
    pub fn sync_record_ids(&self, kind: SyncKind) -> Result<Vec<String>, Error> {
        let mut statement = self
            .connection
            .prepare(&format!("SELECT id FROM {} ORDER BY id", kind.table()))?;
        Ok(statement
            .query_map([], |row| row.get(0))?
            .collect::<Result<_, _>>()?)
    }

    /// One record as its sync file's fields, read in a single snapshot. Device-local
    /// data (checkout folders, inbox state, credentials) is never part of it.
    pub fn export_sync_record(&self, kind: SyncKind, id: &str) -> Result<SyncRecord, Error> {
        let record = crate::read_scope::run(&self.connection, |connection| {
            read_record(connection, kind, id)
        })?;
        record.ok_or_else(|| match kind {
            SyncKind::Project => Error::ProjectNotFound(id.to_owned()),
            SyncKind::Document => Error::DocumentNotFound(id.to_owned()),
            SyncKind::Plan => Error::PlanNotFound(id.to_owned()),
            SyncKind::Ticket => Error::NotFound(id.to_owned()),
            SyncKind::AutomationAgent => Error::AutomationAgentNotFound(id.to_owned()),
            SyncKind::Automation => Error::AutomationNotFound(id.to_owned()),
        })
    }

    /// The record's file text as ticketd writes it to storage: `to_markdown` with the
    /// Ticket reference as a comment beside each ticket GUID this Workspace knows.
    /// Reading ignores the comments, so the GUID alone is the identity.
    pub fn sync_file_text(&self, record: &SyncRecord) -> Result<String, Error> {
        let mut labels = Labels::new();
        let mut statement = self
            .connection
            .prepare("SELECT reference FROM tickets WHERE id = ?1")?;
        for (name, kind, _) in TICKET {
            let ids = match (kind, record.fields.get(*name)) {
                (Type::Ticket, Some(SyncValue::Text(id))) => BTreeSet::from([id.clone()]),
                (Type::Tickets, Some(SyncValue::Set(ids))) => ids.clone(),
                _ => continue,
            };
            for id in ids {
                if let Some(reference) = statement.query_row([&id], |row| row.get(0)).optional()? {
                    labels.insert(id, reference);
                }
            }
        }
        Ok(record.to_text(&labels))
    }

    /// Make the Workspace hold exactly this record, creating it or updating the record
    /// with the same GUID. Fields that already match are not written, and a record
    /// that cannot be applied changes nothing.
    ///
    /// A relationship to a record that is not here yet is skipped and returned; apply
    /// the same record again once that record has arrived. No history or inbox entry
    /// is recorded, and the rules for edits made on this device (Trash, archived Plans,
    /// external ownership, dependency loops) do not apply: the record is taken as it is.
    pub fn apply_sync_record(&mut self, record: &SyncRecord) -> Result<Vec<MissingTarget>, Error> {
        record.validate()?;
        let transaction = self.connection.savepoint()?;
        crate::write_scope::lock(&transaction)?;
        let mut apply = Apply {
            c: &transaction,
            record,
            missing: Vec::new(),
        };
        apply.run()?;
        let missing = apply.missing;
        transaction.commit()?;
        Ok(missing)
    }
}

/// One record as its sync file's fields, or `None` when the Workspace does not hold it.
/// For use inside a write that is already under way.
pub(crate) fn find_record(
    connection: &Connection,
    kind: SyncKind,
    id: &str,
) -> Result<Option<SyncRecord>, Error> {
    read_record(connection, kind, id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_readable_name_collapses_separators_and_cuts_long_titles_at_a_word() {
        assert_eq!(readable_name("Keyboard audit: B"), "Keyboard audit B");
        assert_eq!(readable_name("  a/b\\c \t<d>  "), "a b c d");
        assert_eq!(readable_name("short title"), "short title");
        let exact = "x".repeat(NAME_CHARS);
        assert_eq!(readable_name(&exact), exact);

        let long = "word ".repeat(30);
        let name = readable_name(&long);
        assert!(name.chars().count() <= NAME_CHARS, "{name}");
        assert!(name.ends_with("word…"), "{name}");

        let one_word = "é".repeat(100);
        let name = readable_name(&one_word);
        assert_eq!(name.chars().count(), NAME_CHARS);
        assert!(name.ends_with("é…"));
    }

    /// What a file of format 1 holds after `kind`, `format` and `id`. Automations
    /// and their agents joined without a new number: a ticketd from before them
    /// does not look in their folders, so it never meets a kind it does not know.
    const FORMAT_1: &str = "\
project: name
document: title created_at tags origin_activity trashed kept pinned
plan: name archived spec documents
ticket: ref title status project plan parent blocked_by blocked_since blocked_by_removed parent_removed related discovered duplicate_of duplicate_restore tags documents attachments trashed following reminder source_provider source_external_id source_locator source_display source_url source_origin source_linked_at source_authority source_authority_changed_at source_state source_closure_reason source_updated_at
automation_agent: name harness model turn_limit time_limit_minutes read_files edit_files run_commands any_command allowed_commands use_web trashed
automation: name trashed
<!-- ticketd:activity -->: reported_at updated_at agent document
<!-- ticketd:evidence -->: kind name value created_at updated_at agent
";

    /// Pins field names and section markers only, not the forms their values
    /// take. A new value form in an existing field (such as the `<GUID> <n>` item
    /// of `parent_removed`) is rejected by a ticketd that does not
    /// know it just the same, so it also requires raising FILE_FORMAT, with
    /// nothing here failing to say so.
    #[test]
    fn the_fields_and_section_markers_of_the_current_format_are_pinned() {
        // A section kind added here must also join `parts` below.
        match SyncPartKind::Activity {
            SyncPartKind::Activity | SyncPartKind::Evidence => {}
        }
        let parts = [SyncPartKind::Activity, SyncPartKind::Evidence];
        let blocks = SyncKind::ALL
            .into_iter()
            .map(|kind| (kind.name().to_owned(), Block::Record(kind)))
            .chain(parts.into_iter().map(|kind| {
                (
                    format!("<!-- ticketd:{} -->", kind.name()),
                    Block::Part(kind),
                )
            }));
        let mut written = String::new();
        for (label, block) in blocks {
            let names: Vec<_> = shape(block).0.iter().map(|field| field.0).collect();
            written.push_str(&format!("{label}: {}\n", names.join(" ")));
        }
        assert_eq!(
            (FILE_FORMAT, written.as_str()),
            (1, FORMAT_1),
            "The header fields or section markers of sync files changed. A ticketd that does not know a field rejects the whole file, and only a higher `format` tells it the file is from a newer ticketd: raise FILE_FORMAT in the same change, then pin the new list here under the new number."
        );
    }
}
