//! The Documents view that opens first: the Documents of work still going on, grouped by Plan
//! (GLOSSARY.md, Current work), with counts for the two groups that stay closed.

use crate::documents::{DocumentSummary, summary_columns, summary_from_row};
use crate::{Error, Workspace};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// The Plan a group is named for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CurrentWorkPlan {
    pub id: String,
    pub name: String,
}

/// One Plan's current Documents, its spec first, then the most recently updated. A group
/// without a Plan holds the Documents of open tickets that have no Active Plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CurrentWorkGroup {
    pub plan: Option<CurrentWorkPlan>,
    pub documents: Vec<DocumentSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CurrentWork {
    /// Active Plans by their most recently updated Document, then the group without a Plan.
    pub groups: Vec<CurrentWorkGroup>,
    /// Documents linked to a Plan or ticket, none of them an Active Plan or an open ticket.
    pub finished: u32,
    /// Documents with no Plan and no ticket (tickets in Trash do not count).
    pub unlinked: u32,
    /// Documents in Trash.
    pub trashed: u32,
}

/// Every live Document with where it belongs. A ticket links a Document when it mentions or
/// attaches it (the same links a list row shows), and is open in Todo, In progress or In review.
/// `?1` includes Activity details, as in every other browsing read.
const CLASSIFIED: &str = "SELECT d.id AS id, d.updated_at AS updated_at,
    (SELECT id FROM (SELECT p.id AS id, p.name AS name, coalesce(p.spec_document_id = d.id, 0) AS spec FROM plan_documents pd JOIN plans p ON p.id = pd.plan_id WHERE pd.document_id = d.id AND p.archived = 0) ORDER BY spec DESC, name, id LIMIT 1) AS own_plan,
    (SELECT p.id FROM tickets t JOIN plans p ON p.id = t.plan_id WHERE t.trashed = 0 AND t.status IN ({OPEN}) AND p.archived = 0 AND t.id IN (SELECT m.source_id FROM {MENTIONS} m WHERE m.target_id = d.id) ORDER BY p.name, p.id LIMIT 1) AS ticket_plan,
    EXISTS (SELECT 1 FROM tickets t WHERE t.trashed = 0 AND t.status IN ({OPEN}) AND t.id IN (SELECT m.source_id FROM {MENTIONS} m WHERE m.target_id = d.id)) AS open_ticket,
    (EXISTS (SELECT 1 FROM plan_documents pd WHERE pd.document_id = d.id) OR EXISTS (SELECT 1 FROM tickets t WHERE t.trashed = 0 AND t.id IN (SELECT m.source_id FROM {MENTIONS} m WHERE m.target_id = d.id))) AS linked
    FROM documents d WHERE d.trashed = 0 AND (?1 OR d.originating_activity_id IS NULL OR d.kept = 1)";

fn classified() -> String {
    CLASSIFIED
        .replace("{MENTIONS}", crate::document_links::DOCUMENT_MENTIONS)
        .replace("{OPEN}", crate::documents::OPEN_TICKET_STATUSES)
}

impl Workspace {
    /// The Documents of Active Plans and open tickets, grouped, with the sizes of Finished work
    /// and of the Documents with no Plan or ticket; read those with
    /// [`finished_documents_page`](Self::finished_documents_page) and
    /// [`unlinked_documents_page`](Self::unlinked_documents_page).
    pub fn current_work(&self, include_support: bool) -> Result<CurrentWork, Error> {
        self.read(|_| {
            let classified = classified();
            let mut statement = self.connection.prepare(&format!(
                "SELECT id, updated_at, coalesce(own_plan, ticket_plan), open_ticket OR own_plan IS NOT NULL, linked FROM ({classified})"
            ))?;
            let mut current: Vec<(String, String, Option<String>)> = Vec::new();
            let (mut finished, mut unlinked) = (0u32, 0u32);
            for row in statement.query_map([include_support], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, bool>(3)?,
                    row.get::<_, bool>(4)?,
                ))
            })? {
                let (id, updated_at, plan, is_current, linked) = row?;
                if is_current {
                    current.push((id, updated_at, plan));
                } else if linked {
                    finished += 1;
                } else {
                    unlinked += 1;
                }
            }
            let trashed: u32 = self.connection.query_row(
                "SELECT count(*) FROM documents WHERE trashed = 1",
                [],
                |row| row.get(0),
            )?;
            let mut plans: HashMap<String, (CurrentWorkPlan, Option<String>)> = HashMap::new();
            let mut statement = self.connection.prepare(
                "SELECT id, name, spec_document_id FROM plans WHERE archived = 0",
            )?;
            for row in statement.query_map([], |row| {
                Ok((
                    CurrentWorkPlan {
                        id: row.get(0)?,
                        name: row.get(1)?,
                    },
                    row.get::<_, Option<String>>(2)?,
                ))
            })? {
                let (plan, spec) = row?;
                plans.insert(plan.id.clone(), (plan, spec));
            }
            let ids = serde_json::to_string(
                &current.iter().map(|(id, ..)| id.as_str()).collect::<Vec<_>>(),
            )?;
            let columns = summary_columns();
            let mut statement = self.connection.prepare(&format!(
                "SELECT {columns} FROM documents d WHERE d.id IN (SELECT value FROM json_each(?1))"
            ))?;
            let mut summaries: HashMap<String, DocumentSummary> = HashMap::new();
            for summary in statement.query_map([ids], |row| summary_from_row(row, None))? {
                let summary = summary?;
                summaries.insert(summary.id.clone(), summary);
            }
            // (plan id, spec, updated_at, summary); a group with no Plan has a None id.
            let mut grouped: HashMap<Option<String>, Vec<(bool, String, DocumentSummary)>> =
                HashMap::new();
            for (id, updated_at, plan) in current {
                let Some(summary) = summaries.remove(&id) else {
                    continue;
                };
                let spec = plan
                    .as_ref()
                    .and_then(|plan| plans.get(plan))
                    .is_some_and(|(_, spec)| spec.as_deref() == Some(id.as_str()));
                grouped
                    .entry(plan)
                    .or_default()
                    .push((spec, updated_at, summary));
            }
            let mut groups: Vec<(String, CurrentWorkGroup)> = grouped
                .into_iter()
                .map(|(plan, mut documents)| {
                    documents.sort_by(|a, b| {
                        b.0.cmp(&a.0)
                            .then_with(|| b.1.cmp(&a.1))
                            .then_with(|| a.2.id.cmp(&b.2.id))
                    });
                    let newest = documents.iter().map(|d| d.1.clone()).max().unwrap_or_default();
                    (
                        newest,
                        CurrentWorkGroup {
                            plan: plan
                                .and_then(|plan| plans.get(&plan))
                                .map(|(plan, _)| plan.clone()),
                            documents: documents.into_iter().map(|d| d.2).collect(),
                        },
                    )
                })
                .collect();
            groups.sort_by(|(a_newest, a), (b_newest, b)| {
                a.plan
                    .is_none()
                    .cmp(&b.plan.is_none())
                    .then_with(|| b_newest.cmp(a_newest))
                    .then_with(|| {
                        a.plan
                            .as_ref()
                            .map(|p| (&p.name, &p.id))
                            .cmp(&b.plan.as_ref().map(|p| (&p.name, &p.id)))
                    })
            });
            Ok(CurrentWork {
                groups: groups.into_iter().map(|(_, group)| group).collect(),
                finished,
                unlinked,
                trashed,
            })
        })
    }

    /// Finished work: linked Documents none of whose links is an Active Plan or an open
    /// ticket, most recently updated first.
    pub fn finished_documents_page(
        &self,
        limit: u32,
        offset: u32,
        include_support: bool,
    ) -> Result<Vec<DocumentSummary>, Error> {
        self.classified_page(
            "open_ticket = 0 AND own_plan IS NULL AND linked = 1",
            limit,
            offset,
            include_support,
        )
    }

    /// Documents with no Plan and no ticket, most recently updated first.
    pub fn unlinked_documents_page(
        &self,
        limit: u32,
        offset: u32,
        include_support: bool,
    ) -> Result<Vec<DocumentSummary>, Error> {
        self.classified_page("linked = 0", limit, offset, include_support)
    }

    fn classified_page(
        &self,
        condition: &str,
        limit: u32,
        offset: u32,
        include_support: bool,
    ) -> Result<Vec<DocumentSummary>, Error> {
        let classified = classified();
        let columns = summary_columns();
        let mut statement = self.connection.prepare(&format!(
            "SELECT {columns} FROM documents d JOIN ({classified}) c ON c.id = d.id WHERE {condition} ORDER BY d.updated_at DESC, d.id LIMIT ?2 OFFSET ?3"
        ))?;
        Ok(statement
            .query_map(params![include_support, limit.min(100), offset], |row| {
                summary_from_row(row, None)
            })?
            .collect::<Result<_, _>>()?)
    }

    /// Every live Document by title, one bounded page at a time. Activity details are
    /// included only when asked for or kept.
    pub fn documents_by_title_page(
        &self,
        limit: u32,
        offset: u32,
        include_support: bool,
    ) -> Result<Vec<DocumentSummary>, Error> {
        let columns = summary_columns();
        let heading = crate::documents::HEADING;
        let mut statement = self.connection.prepare(&format!(
            "SELECT {columns} FROM documents d WHERE d.trashed = 0 AND (?3 OR d.originating_activity_id IS NULL OR d.kept = 1) ORDER BY lower({heading}), d.id LIMIT ?1 OFFSET ?2"
        ))?;
        Ok(statement
            .query_map(params![limit.min(100), offset, include_support], |row| {
                summary_from_row(row, None)
            })?
            .collect::<Result<_, _>>()?)
    }
}
