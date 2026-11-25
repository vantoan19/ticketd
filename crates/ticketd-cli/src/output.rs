//! How the command line prints JSON, so every command answers the same way.
//!
//! - A write with nothing meaningful to return prints [`ok`].
//! - Keys follow each struct's declaration order. `serde_json::Value` sorts its keys,
//!   so output is built from typed values (never from `json!` or a `Value` round trip).

use serde::{Deserialize, Serialize, Serializer, de};
use serde_json::value::RawValue;
use ticketd_core::{TicketWithUpdate, WriteResult};

type Failure = Box<dyn std::error::Error>;

/// What a write prints when it has no record to return.
pub fn ok() -> String {
    r#"{"ok":true}"#.into()
}

/// The value of a write result without its `{"kind","value"}` wrapper, so a retried
/// command prints the same object as the first run.
pub fn bare(result: WriteResult) -> Result<String, Failure> {
    Ok(match result {
        WriteResult::RemoteAttachmentRemoved(value) => serde_json::to_string(&value)?,
        WriteResult::Attachment(value) => serde_json::to_string(&value)?,
        WriteResult::Document(value) => serde_json::to_string(&value)?,
        WriteResult::Ticket(value) => serde_json::to_string(&value)?,
        WriteResult::Tickets(value) => serde_json::to_string(&value)?,
        WriteResult::Activity(value) => serde_json::to_string(&value)?,
        WriteResult::Evidence(value) => serde_json::to_string(&value)?,
        WriteResult::Project(value) => serde_json::to_string(&value)?,
        WriteResult::Plan(value) => serde_json::to_string(&value)?,
        WriteResult::Reminder(Some(value)) => serde_json::to_string(&value)?,
        WriteResult::Following(value) | WriteResult::InboxRead(value) => {
            serde_json::to_string(&value)?
        }
        WriteResult::Reminder(None) | WriteResult::Deleted => ok(),
    })
}

/// A `list --latest-update` or `search --latest-update` row. The bounded update sits
/// beside the ticket, so the ticket's own three-key `latest_update` is left out: one
/// name, one shape. Every other ticket field keeps its place.
pub struct UpdateRow<'a>(pub &'a TicketWithUpdate);

impl Serialize for UpdateRow<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::{Error, SerializeStruct};
        let ticket = serde_json::to_string(&self.0.ticket).map_err(S::Error::custom)?;
        let fields: Fields = serde_json::from_str(&ticket).map_err(S::Error::custom)?;
        let mut row = serializer.serialize_struct("UpdateRow", 2)?;
        row.serialize_field("ticket", &fields.without("latest_update"))?;
        row.serialize_field("latest_update", &self.0.latest_update)?;
        row.end()
    }
}

/// A JSON object's members in the order they were written.
struct Fields(Vec<(String, Box<RawValue>)>);

impl Fields {
    fn without<'a>(&'a self, key: &'a str) -> impl Serialize + 'a {
        struct Kept<'a>(&'a Fields, &'a str);
        impl Serialize for Kept<'_> {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.collect_map(
                    self.0
                        .0
                        .iter()
                        .filter(|(name, _)| name != self.1)
                        .map(|(name, value)| (name, value)),
                )
            }
        }
        Kept(self, key)
    }
}

impl<'de> Deserialize<'de> for Fields {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Members;
        impl<'de> de::Visitor<'de> for Members {
            type Value = Fields;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a JSON object")
            }
            fn visit_map<A: de::MapAccess<'de>>(self, mut map: A) -> Result<Fields, A::Error> {
                let mut fields = Vec::new();
                while let Some(entry) = map.next_entry()? {
                    fields.push(entry);
                }
                Ok(Fields(fields))
            }
        }
        deserializer.deserialize_map(Members)
    }
}

/// `ticketd workspace`.
#[derive(Serialize)]
pub struct WorkspaceStatus {
    pub path: std::path::PathBuf,
    pub format_version: Option<i64>,
    pub supported_format_version: i64,
}

/// One entry of `ticketd source list`.
#[derive(Serialize)]
pub struct SourceListing<D: Serialize, S: Serialize> {
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub development: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub unavailable: bool,
    pub connector: D,
    pub saved: S,
}

/// One page of `ticketd document read`.
#[derive(Serialize)]
pub struct DocumentSlice<'a> {
    pub id: &'a str,
    pub title: &'a Option<String>,
    pub summary: &'a Option<String>,
    pub created_at: &'a str,
    pub updated_at: &'a str,
    pub trashed: bool,
    pub body: &'a str,
    pub offset: usize,
    pub next_offset: Option<usize>,
    pub truncated: bool,
    pub fetch: Option<String>,
}

/// `ticketd attachment limit`.
#[derive(Serialize)]
pub struct AttachmentLimit {
    pub limit_bytes: u64,
    pub default_bytes: u64,
}

/// `ticketd attachment export`.
#[derive(Serialize)]
pub struct ExportedAttachment<'a> {
    pub id: &'a str,
    pub path: &'a str,
}

/// `ticketd attachment complete-draft-migration`.
#[derive(Serialize)]
pub struct DraftMigration {
    pub legacy_drafts_pending: bool,
}

/// `ticketd reminder show`, `set` and `snooze`: the reminder the ticket has now.
#[derive(Serialize)]
pub struct Reminder {
    pub reference: String,
    pub due_at: Option<String>,
}

/// `ticketd reminder dismiss`: whether there was a reminder to remove.
#[derive(Serialize)]
pub struct Dismissed {
    pub dismissed: bool,
}

/// `ticketd backup`.
#[derive(Serialize)]
pub struct BackupSaved {
    pub path: String,
}

/// `ticketd restore-workspace`: the workspace file now holding the backup, and the
/// complete copy of what it replaced.
#[derive(Serialize)]
pub struct Restored {
    pub restored: std::path::PathBuf,
    pub safety_backup: std::path::PathBuf,
}
