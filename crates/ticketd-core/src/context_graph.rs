use crate::{Error, Workspace};
use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

const MAX_NODES: usize = 50;
const GROUP_LIMIT: usize = 50;
const MAX_EDGES: usize = 300;

#[derive(Debug, Serialize)]
pub struct ContextGraphNode {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub state: Option<String>,
    pub trashed: bool,
    pub activity_detail: bool,
}
#[derive(Debug, Serialize)]
pub struct ContextGraphEdge {
    pub source: String,
    pub target: String,
    pub kind: String,
    pub explanation: Option<String>,
}
#[derive(Debug, Serialize)]
pub struct ContextGraph {
    pub center: String,
    pub nodes: Vec<ContextGraphNode>,
    pub edges: Vec<ContextGraphEdge>,
    pub omitted: bool,
    pub hidden_details: bool,
    pub max_nodes: usize,
    pub max_edges: usize,
    pub max_work: usize,
}

impl Workspace {
    pub fn context_graph(
        &self,
        reference: &str,
        include_details: bool,
    ) -> Result<ContextGraph, Error> {
        let tx = self.connection.unchecked_transaction()?;
        let center: String = if let Some(number) = reference
            .strip_prefix("T-")
            .and_then(|v| v.parse::<i64>().ok())
        {
            tx.query_row("SELECT id FROM tickets WHERE number = ?1", [number], |r| {
                r.get(0)
            })
            .optional()?
            .ok_or_else(|| Error::NotFound(reference.to_owned()))?
        } else {
            tx.query_row("SELECT id FROM entities WHERE id = ?1", [reference], |r| {
                r.get(0)
            })
            .optional()?
            .ok_or_else(|| Error::NotFound(reference.to_owned()))?
        };
        // Each independently indexed direction has its own limit: a hub in one
        // relationship cannot consume all the work reserved for other groups.
        let groups = [
            (
                "SELECT blocker_id, dependent_id, NULL FROM dependencies WHERE blocker_id = ?1 ORDER BY dependent_id LIMIT ?2",
                "blocks",
            ),
            (
                "SELECT blocker_id, dependent_id, NULL FROM dependencies WHERE dependent_id = ?1 ORDER BY blocker_id LIMIT ?2",
                "blocks",
            ),
            (
                "SELECT plan_id, id, NULL FROM tickets WHERE plan_id = ?1 ORDER BY trashed, number LIMIT ?2",
                "membership",
            ),
            (
                "SELECT plan_id, id, NULL FROM tickets WHERE id = ?1 AND plan_id IS NOT NULL LIMIT ?2",
                "membership",
            ),
            (
                "SELECT pd.plan_id, pd.document_id, CASE WHEN p.spec_document_id = pd.document_id THEN 'Primary spec' ELSE NULL END FROM plan_documents pd JOIN plans p ON p.id = pd.plan_id WHERE pd.plan_id = ?1 ORDER BY pd.document_id LIMIT ?2",
                "document",
            ),
            (
                "SELECT pd.plan_id, pd.document_id, CASE WHEN p.spec_document_id = pd.document_id THEN 'Primary spec' ELSE NULL END FROM plan_documents pd JOIN plans p ON p.id = pd.plan_id WHERE pd.document_id = ?1 ORDER BY pd.plan_id LIMIT ?2",
                "document",
            ),
            (
                "SELECT m.source_id, t.id, m.passage FROM numeric_mentions m JOIN tickets t ON t.number = m.number WHERE m.source_id = ?1 AND m.activity = 0 ORDER BY m.number, m.passage LIMIT ?2",
                "mention",
            ),
            (
                "SELECT m.source_id, t.id, m.passage FROM tickets t JOIN numeric_mentions m ON m.number = t.number AND m.activity = 0 WHERE t.id = ?1 ORDER BY m.source_id, m.passage LIMIT ?2",
                "mention",
            ),
            (
                "SELECT a.ticket_id, t.id, m.passage FROM activities a JOIN numeric_mentions m ON m.source_id = a.id AND m.activity = 1 JOIN tickets t ON t.number = m.number WHERE a.ticket_id = ?1 ORDER BY a.id, m.number, m.passage LIMIT ?2",
                "activity",
            ),
            (
                "SELECT a.ticket_id, t.id, m.passage FROM tickets t JOIN numeric_mentions m ON m.number = t.number AND m.activity = 1 JOIN activities a ON a.id = m.source_id WHERE t.id = ?1 ORDER BY m.source_id, m.passage LIMIT ?2",
                "activity",
            ),
            (
                "SELECT source_id, target_id, passage FROM context_mentions WHERE source_id = ?1 ORDER BY target_id, passage LIMIT ?2",
                "mention",
            ),
            (
                "SELECT source_id, target_id, passage FROM context_mentions WHERE target_id = ?1 ORDER BY source_id, passage LIMIT ?2",
                "mention",
            ),
            (
                "SELECT a.ticket_id, m.target_id, m.passage FROM activities a JOIN activity_mentions m ON m.activity_id = a.id WHERE a.ticket_id = ?1 ORDER BY a.id, m.target_id, m.passage LIMIT ?2",
                "activity",
            ),
            (
                "SELECT a.ticket_id, m.target_id, m.passage FROM activity_mentions m JOIN activities a ON a.id = m.activity_id WHERE m.target_id = ?1 ORDER BY m.activity_id, m.passage LIMIT ?2",
                "activity",
            ),
            (
                "SELECT ticket_id, supporting_document_id, substr(brief, 1, 512) FROM activities WHERE ticket_id = ?1 AND supporting_document_id IS NOT NULL ORDER BY supporting_document_id, id LIMIT ?2",
                "support",
            ),
            (
                "SELECT ticket_id, supporting_document_id, substr(brief, 1, 512) FROM activities WHERE supporting_document_id = ?1 ORDER BY ticket_id, id LIMIT ?2",
                "support",
            ),
        ];
        let mut candidate_groups = Vec::new();
        let mut omitted = false;
        for (sql, kind) in groups {
            let mut statement = tx.prepare(sql)?;
            let rows = statement
                .query_map(params![center, (GROUP_LIMIT + 1) as i64], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            if rows.len() > GROUP_LIMIT {
                omitted = true;
            }
            let mut candidates = Vec::new();
            for (source, target, explanation) in rows.into_iter().take(GROUP_LIMIT) {
                let kind = if kind == "document" && explanation.is_some() {
                    "spec"
                } else {
                    kind
                };
                candidates.push((source, target, kind.to_owned(), explanation));
            }
            candidate_groups.push(candidates.into_iter());
        }
        let mut candidates = Vec::new();
        loop {
            let before = candidates.len();
            for group in &mut candidate_groups {
                if let Some(candidate) = group.next() {
                    candidates.push(candidate);
                }
            }
            if before == candidates.len() {
                break;
            }
        }
        let mut candidate_ids = BTreeSet::from([center.clone()]);
        for (source, target, _, _) in &candidates {
            candidate_ids.insert(source.clone());
            candidate_ids.insert(target.clone());
        }
        let mut hidden = BTreeSet::new();
        let candidate_ids: Vec<_> = candidate_ids.into_iter().collect();
        for chunk in candidate_ids.chunks(100) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let mut statement = tx.prepare(&format!("SELECT id FROM documents WHERE id IN ({placeholders}) AND originating_activity_id IS NOT NULL AND NOT kept"))?;
            hidden.extend(
                statement
                    .query_map(rusqlite::params_from_iter(chunk), |r| r.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?,
            );
        }
        let mut ids = BTreeSet::from([center.clone()]);
        let mut edges = Vec::new();
        let mut hidden_details = false;
        let mut seen = BTreeSet::new();
        for (source, target, kind, explanation) in candidates {
            if !seen.insert((
                source.clone(),
                target.clone(),
                kind.clone(),
                explanation.clone(),
            )) {
                continue;
            }
            let other = if source == center { &target } else { &source };
            if !ids.contains(other) {
                if hidden.contains(other) && !include_details && other != &center {
                    hidden_details = true;
                    continue;
                }
                if !ids.contains(other) && ids.len() == MAX_NODES {
                    omitted = true;
                    continue;
                }
                ids.insert(other.clone());
            }
            if edges.len() == MAX_EDGES {
                omitted = true;
                break;
            }
            edges.push(ContextGraphEdge {
                source,
                target,
                kind,
                explanation,
            });
        }
        // Check edges between selected neighbors under an independent, bounded
        // per-anchor quota. Each subquery can stop on its adjacency index.
        let anchors: Vec<_> = ids.iter().filter(|id| *id != &center).cloned().collect();
        const INDUCED_QUOTA: usize = 2;
        for (sql, kind) in groups {
            if anchors.is_empty() {
                break;
            }
            let term = format!(
                "SELECT ? AS anchor, * FROM ({})",
                sql.replace("?1", "?").replace("?2", "3")
            );
            let query = vec![term; anchors.len()].join(" UNION ALL ");
            let mut statement = tx.prepare(&query)?;
            let parameters = anchors.iter().flat_map(|anchor| [anchor, anchor]);
            let rows = statement
                .query_map(rusqlite::params_from_iter(parameters), |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, Option<String>>(3)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let mut counts = BTreeMap::<String, usize>::new();
            for (anchor, source, target, explanation) in rows {
                let count = counts.entry(anchor).or_default();
                *count += 1;
                if *count > INDUCED_QUOTA {
                    omitted = true;
                    continue;
                }
                if !ids.contains(&source) || !ids.contains(&target) {
                    continue;
                }
                let kind = if kind == "document" && explanation.is_some() {
                    "spec"
                } else {
                    kind
                };
                if !seen.insert((
                    source.clone(),
                    target.clone(),
                    kind.to_owned(),
                    explanation.clone(),
                )) {
                    continue;
                }
                if edges.len() == MAX_EDGES {
                    omitted = true;
                    break;
                }
                edges.push(ContextGraphEdge {
                    source,
                    target,
                    kind: kind.to_owned(),
                    explanation,
                });
            }
        }
        let nodes = graph_nodes(&tx, &ids)?;
        tx.commit()?;
        Ok(ContextGraph {
            center,
            nodes,
            edges,
            omitted,
            hidden_details,
            max_nodes: MAX_NODES,
            max_edges: MAX_EDGES,
            max_work: groups.len() * (GROUP_LIMIT + 1 + (MAX_NODES - 1) * (INDUCED_QUOTA + 1)),
        })
    }
}
fn graph_nodes(
    tx: &rusqlite::Connection,
    ids: &BTreeSet<String>,
) -> Result<Vec<ContextGraphNode>, Error> {
    let ids: Vec<_> = ids.iter().cloned().collect();
    let mut nodes = Vec::new();
    for chunk in ids.chunks(100) {
        let placeholders = vec!["?"; chunk.len()].join(",");
        let sql = format!(
            "SELECT id, 'ticket', 'T-' || number || ' · ' || substr(title, 1, 200), status, trashed, 0 FROM tickets WHERE id IN ({placeholders}) UNION ALL SELECT d.id, 'document', {}, NULL, d.trashed, d.originating_activity_id IS NOT NULL AND NOT d.kept FROM documents d WHERE d.id IN ({placeholders}) UNION ALL SELECT id, 'plan', substr(name, 1, 200), CASE WHEN archived THEN 'Archived' ELSE 'Active' END, 0, 0 FROM plans WHERE id IN ({placeholders})",
            crate::documents::HEADING
        );
        let mut statement = tx.prepare(&sql)?;
        let parameters = (0..3).flat_map(|_| chunk.iter());
        nodes.extend(
            statement
                .query_map(rusqlite::params_from_iter(parameters), |r| {
                    Ok(ContextGraphNode {
                        id: r.get(0)?,
                        kind: r.get(1)?,
                        label: r.get(2)?,
                        state: r.get(3)?,
                        trashed: r.get(4)?,
                        activity_detail: r.get(5)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?,
        );
    }
    nodes.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(nodes)
}
