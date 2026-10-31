use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::{Error, Status, Workspace, relationships, ticket_from_row};

const PAGE: usize = 20;
const TEXT: usize = 4096;
const LABEL: usize = 256;

#[derive(Debug, Default, Deserialize)]
pub struct ContextOptions {
    pub project: bool,
    pub effort: bool,
    pub relationships: bool,
    pub notes: bool,
    pub backlinks: bool,
    pub offset: u32,
}
#[derive(Debug, Serialize)]
pub struct BoundedText {
    pub text: String,
    pub truncated: bool,
}
#[derive(Debug, Serialize)]
pub struct ContextPage<T> {
    pub items: Vec<T>,
    pub next_offset: Option<u32>,
}
#[derive(Debug, Serialize)]
pub struct ContextTicket {
    pub reference: String,
    pub id: String,
    pub title: BoundedText,
    pub body: BoundedText,
    pub status: Status,
    pub trashed: bool,
    pub availability: Option<String>,
    pub tags: ContextPage<BoundedText>,
}
#[derive(Debug, Serialize)]
pub struct ContextLink {
    pub id: String,
    pub name: BoundedText,
    pub archived: Option<bool>,
}
#[derive(Debug, Serialize)]
pub struct ContextRelated {
    pub reference: String,
    pub title: BoundedText,
    pub status: Status,
    pub trashed: bool,
    pub unresolved: bool,
}
#[derive(Debug, Serialize)]
pub struct ContextRelationships {
    pub parent: Option<ContextRelated>,
    pub children: ContextPage<ContextRelated>,
    pub prerequisites: ContextPage<ContextRelated>,
    pub blocking: ContextPage<ContextRelated>,
    pub duplicate_of: Option<ContextRelated>,
    pub duplicates: ContextPage<ContextRelated>,
}
#[derive(Debug, Serialize)]
pub struct ContextNote {
    pub id: String,
    pub content: BoundedText,
    pub created_at: String,
    pub updated_at: String,
    pub editing_agent: Option<BoundedText>,
}
#[derive(Debug, Serialize)]
pub struct TicketContext {
    pub ticket: ContextTicket,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<Option<ContextLink>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<Option<ContextLink>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relationships: Option<ContextRelationships>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<ContextPage<ContextNote>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backlinks: Option<ContextPage<crate::Backlink>>,
}
fn text(value: String, limit: usize) -> BoundedText {
    let mut chars = value.chars();
    let text = chars.by_ref().take(limit).collect();
    BoundedText {
        text,
        truncated: chars.next().is_some(),
    }
}
fn page<T>(mut items: Vec<T>, offset: u32) -> ContextPage<T> {
    let more = items.len() > PAGE;
    items.truncate(PAGE);
    ContextPage {
        items,
        next_offset: if more {
            offset.checked_add(PAGE as u32)
        } else {
            None
        },
    }
}
fn related(
    conn: &Connection,
    sql: &str,
    id: &str,
    offset: u32,
) -> Result<ContextPage<ContextRelated>, Error> {
    let mut stmt = conn.prepare(sql)?;
    let items = stmt
        .query_map(params![id, PAGE as u32 + 1, offset], |r| {
            let status: Status = r.get::<_, String>(2)?.parse().map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    2,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })?;
            Ok(ContextRelated {
                reference: format!("T-{}", r.get::<_, i64>(0)?),
                title: text(r.get(1)?, LABEL),
                status,
                trashed: r.get(3)?,
                unresolved: status != Status::Done,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(page(items, offset))
}
impl Workspace {
    pub fn ticket_context(
        &self,
        reference: &str,
        options: ContextOptions,
    ) -> Result<TicketContext, Error> {
        let tx = self.connection.unchecked_transaction()?;
        let id = relationships::id(&tx, reference)?;
        let ticket = tx.query_row("SELECT id, number, title, status, body, project_id, effort_id, trashed FROM tickets WHERE id = ?1", [&id], ticket_from_row)?;
        let blocked: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM dependencies d JOIN tickets t ON t.id = d.blocker_id WHERE d.dependent_id = ?1 AND t.status != 'Done')", [&id], |r| r.get(0))?;
        let availability = if ticket.status == Status::Todo {
            Some(if blocked { "Blocked" } else { "Ready" }.to_owned())
        } else {
            None
        };
        let tags = {
            let mut stmt = tx.prepare("SELECT tag_name FROM ticket_tags WHERE ticket_id = ?1 ORDER BY tag_name LIMIT ?2 OFFSET ?3")?;
            let rows = stmt
                .query_map(params![id, PAGE as u32 + 1, options.offset], |r| {
                    Ok(text(r.get(0)?, LABEL))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            page(rows, options.offset)
        };
        let project = if options.project {
            Some(match ticket.project_id {
                Some(id) => Some(
                    tx.query_row("SELECT id, name FROM projects WHERE id = ?1", [&id], |r| {
                        Ok(ContextLink {
                            id: r.get(0)?,
                            name: text(r.get(1)?, LABEL),
                            archived: None,
                        })
                    })
                    .optional()?
                    .ok_or(Error::ProjectNotFound(id))?,
                ),
                None => None,
            })
        } else {
            None
        };
        let effort = if options.effort {
            Some(match ticket.effort_id {
                Some(id) => Some(
                    tx.query_row(
                        "SELECT id, name, archived FROM efforts WHERE id = ?1",
                        [&id],
                        |r| {
                            Ok(ContextLink {
                                id: r.get(0)?,
                                name: text(r.get(1)?, LABEL),
                                archived: Some(r.get(2)?),
                            })
                        },
                    )
                    .optional()?
                    .ok_or(Error::EffortNotFound(id))?,
                ),
                None => None,
            })
        } else {
            None
        };
        let relationships = if options.relationships {
            let missing: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM ticket_parents p LEFT JOIN tickets t ON t.id = CASE WHEN p.child_id = ?1 THEN p.parent_id ELSE p.child_id END WHERE (p.child_id = ?1 OR p.parent_id = ?1) AND t.id IS NULL UNION ALL SELECT 1 FROM dependencies d LEFT JOIN tickets t ON t.id = CASE WHEN d.blocker_id = ?1 THEN d.dependent_id ELSE d.blocker_id END WHERE (d.blocker_id = ?1 OR d.dependent_id = ?1) AND t.id IS NULL)", [&id], |r| r.get(0))?;
            if missing {
                return Err(Error::MissingRelatedTicket);
            }
            let parent = related(&tx, "SELECT t.number,t.title,t.status,t.trashed FROM ticket_parents p JOIN tickets t ON t.id=p.parent_id WHERE p.child_id=?1 ORDER BY t.number LIMIT ?2 OFFSET ?3", &id, 0)?.items.into_iter().next();
            Some(ContextRelationships {
                parent,
                duplicate_of: related(&tx, "SELECT t.number,t.title,t.status,t.trashed FROM duplicate_tickets d JOIN tickets t ON t.id=d.canonical_id WHERE d.source_id=?1 ORDER BY t.number LIMIT ?2 OFFSET ?3", &id, 0)?.items.into_iter().next(),
                duplicates: related(&tx, "SELECT t.number,t.title,t.status,t.trashed FROM duplicate_tickets d JOIN tickets t ON t.id=d.source_id WHERE d.canonical_id=?1 ORDER BY t.number LIMIT ?2 OFFSET ?3", &id, options.offset)?,
                children: related(
                    &tx,
                    "SELECT t.number,t.title,t.status,t.trashed FROM ticket_parents p JOIN tickets t ON t.id=p.child_id WHERE p.parent_id=?1 ORDER BY t.number LIMIT ?2 OFFSET ?3",
                    &id,
                    options.offset,
                )?,
                prerequisites: related(
                    &tx,
                    "SELECT t.number,t.title,t.status,t.trashed FROM dependencies d JOIN tickets t ON t.id=d.blocker_id WHERE d.dependent_id=?1 ORDER BY t.number LIMIT ?2 OFFSET ?3",
                    &id,
                    options.offset,
                )?,
                blocking: related(
                    &tx,
                    "SELECT t.number,t.title,t.status,t.trashed FROM dependencies d JOIN tickets t ON t.id=d.dependent_id WHERE d.blocker_id=?1 ORDER BY t.number LIMIT ?2 OFFSET ?3",
                    &id,
                    options.offset,
                )?,
            })
        } else {
            None
        };
        let notes = if options.notes {
            let mut stmt = tx.prepare("SELECT id,content,created_at,updated_at,editing_agent FROM notes WHERE ticket_id=?1 ORDER BY number LIMIT ?2 OFFSET ?3")?;
            let rows = stmt
                .query_map(params![id, PAGE as u32 + 1, options.offset], |r| {
                    Ok(ContextNote {
                        id: r.get(0)?,
                        content: text(r.get(1)?, TEXT),
                        created_at: r.get(2)?,
                        updated_at: r.get(3)?,
                        editing_agent: r.get::<_, Option<String>>(4)?.map(|v| text(v, LABEL)),
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Some(page(rows, options.offset))
        } else {
            None
        };
        let backlinks = if options.backlinks {
            Some(page(
                crate::backlinks::query(&tx, reference, PAGE as u32 + 1, options.offset)?,
                options.offset,
            ))
        } else {
            None
        };
        tx.commit()?;
        Ok(TicketContext {
            ticket: ContextTicket {
                id: ticket.id,
                reference: ticket.reference,
                title: text(ticket.title, LABEL),
                body: text(ticket.body, TEXT),
                status: ticket.status,
                trashed: ticket.trashed,
                availability,
                tags,
            },
            project,
            effort,
            relationships,
            notes,
            backlinks,
        })
    }
}
