const GROUPS: [(&str, &str); 16] = [
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
        "SELECT m.source_id, COALESCE(t.id, ''), m.passage FROM numeric_mentions m LEFT JOIN tickets t ON t.number = m.number WHERE m.source_id = ?1 AND m.activity = 0 ORDER BY m.number, m.passage LIMIT ?2",
        "mention",
    ),
    (
        "SELECT m.source_id, t.id, m.passage FROM tickets t JOIN numeric_mentions m ON m.number = t.number AND m.activity = 0 WHERE t.id = ?1 ORDER BY m.source_id, m.passage LIMIT ?2",
        "mention",
    ),
    (
        "SELECT m.ticket_id, COALESCE(t.id, ''), m.passage FROM activity_graph_numbers m LEFT JOIN tickets t ON t.number = m.number WHERE m.ticket_id = ?1 ORDER BY m.activity_id, m.number, m.passage LIMIT ?2",
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
        "SELECT ticket_id, target_id, passage FROM activity_graph_targets WHERE ticket_id = ?1 ORDER BY activity_id, target_id, passage LIMIT ?2",
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

use crate::{Error, Workspace};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

const MAX_NODES: usize = 100;
const MAX_EXPANSIONS: usize = 8;
const GROUP_LIMIT: usize = 50;
const MAX_EDGES: usize = 300;

#[derive(Debug, Serialize)]
pub struct ContextGraphNode {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub ticket_reference: Option<String>,
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
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextGraphPage {
    pub anchor: String,
    pub group: usize,
    pub offset: usize,
}
#[derive(Debug, Serialize)]
pub struct ContextGraphContinuation {
    pub anchor: String,
    pub group: usize,
    pub kind: String,
    pub next_offset: Option<usize>,
}
#[derive(Debug, Serialize)]
pub struct ContextGraph {
    pub center: String,
    pub nodes: Vec<ContextGraphNode>,
    pub edges: Vec<ContextGraphEdge>,
    pub omitted: bool,
    pub omitted_groups: Vec<String>,
    pub continuations: Vec<ContextGraphContinuation>,
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
        self.context_graph_expanded(reference, include_details, &[])
    }

    pub fn context_graph_expanded(
        &self,
        reference: &str,
        include_details: bool,
        expanded_ids: &[String],
    ) -> Result<ContextGraph, Error> {
        self.context_graph_with_pages(reference, include_details, expanded_ids, &[])
    }

    pub fn context_graph_with_pages(
        &self,
        reference: &str,
        include_details: bool,
        expanded_ids: &[String],
        pages: &[ContextGraphPage],
    ) -> Result<ContextGraph, Error> {
        if expanded_ids.len() + pages.len() > MAX_EXPANSIONS {
            return Err(Error::InvalidBatch(format!(
                "at most {MAX_EXPANSIONS} graph expansions are allowed"
            )));
        }
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
        let groups = GROUPS;
        let mut ids = BTreeSet::from([center.clone()]);
        let mut edges = Vec::new();
        let mut hidden_details = false;
        let mut seen = BTreeSet::new();
        let mut omitted = false;
        let mut omitted_groups = BTreeSet::new();
        let mut continuations = BTreeMap::<(String, usize), ContextGraphContinuation>::new();
        let mut anchors = vec![(center.clone(), None)];
        anchors.extend(expanded_ids.iter().cloned().map(|id| (id, None)));
        for page in pages {
            if page.group >= groups.len()
                || page.offset == 0
                || page.offset > 200
                || page.offset % GROUP_LIMIT != 0
            {
                return Err(Error::InvalidBatch("invalid graph continuation".into()));
            }
            anchors.push((page.anchor.clone(), Some((page.group, page.offset))));
        }
        let mut queue = VecDeque::from(anchors);
        let mut queried = BTreeSet::new();
        let mut stalled = 0;
        while let Some((anchor, page)) = queue.pop_front() {
            if !ids.contains(&anchor)
                || page.is_some_and(|(group, _)| !queried.contains(&(anchor.clone(), group)))
            {
                queue.push_back((anchor, page));
                stalled += 1;
                if stalled >= queue.len() {
                    return Err(Error::InvalidBatch(
                        "graph expansion must target a visible item".into(),
                    ));
                }
                continue;
            }
            stalled = 0;
            if let Some((group, offset)) = page
                && continuations
                    .get(&(anchor.clone(), group))
                    .and_then(|item| item.next_offset)
                    != Some(offset)
            {
                // A fresh snapshot can have fewer rows; do not skip ahead.
                continue;
            }
            let mut candidate_groups = Vec::new();
            for (group, (sql, kind)) in groups.iter().copied().enumerate() {
                if page.is_some_and(|(selected, _)| selected != group) {
                    continue;
                }
                let offset = page.map_or(0, |(_, offset)| offset);
                let sql = format!("{sql} OFFSET ?3");
                let mut statement = tx.prepare(&sql)?;
                let rows = statement
                    .query_map(
                        params![anchor, (GROUP_LIMIT + 1) as i64, offset as i64],
                        |r| {
                            Ok((
                                r.get::<_, String>(0)?,
                                r.get::<_, String>(1)?,
                                r.get::<_, Option<String>>(2)?,
                            ))
                        },
                    )?
                    .collect::<Result<Vec<_>, _>>()?;
                let key = (anchor.clone(), group);
                queried.insert(key.clone());
                if rows.len() > GROUP_LIMIT {
                    continuations.insert(
                        key,
                        ContextGraphContinuation {
                            anchor: anchor.clone(),
                            group,
                            kind: kind.to_owned(),
                            next_offset: (offset < 200).then_some(offset + GROUP_LIMIT),
                        },
                    );
                } else {
                    continuations.remove(&key);
                }
                let mut candidates = Vec::new();
                for (source, target, explanation) in rows.into_iter().take(GROUP_LIMIT) {
                    if target.is_empty() {
                        continue;
                    }
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
            let mut candidate_ids = BTreeSet::from([anchor.clone()]);
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
            for (source, target, kind, explanation) in candidates {
                if !seen.insert((
                    source.clone(),
                    target.clone(),
                    kind.clone(),
                    explanation.clone(),
                )) {
                    continue;
                }
                let other = if source == anchor { &target } else { &source };
                if !ids.contains(other) {
                    if hidden.contains(other) && !include_details && other != &center {
                        hidden_details = true;
                        continue;
                    }
                    if !ids.contains(other) && ids.len() == MAX_NODES {
                        omitted = true;
                        omitted_groups.insert(kind.clone());
                        continue;
                    }
                    ids.insert(other.clone());
                }
                if edges.len() == MAX_EDGES {
                    omitted = true;
                    omitted_groups.insert(kind.clone());
                    break;
                }
                edges.push(ContextGraphEdge {
                    source,
                    target,
                    kind,
                    explanation,
                });
            }
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
                    omitted_groups.insert(kind.to_owned());
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
                    omitted_groups.insert(kind.to_owned());
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
        for continuation in continuations.values_mut() {
            omitted = true;
            omitted_groups.insert(continuation.kind.clone());
            if ids.len() >= MAX_NODES || edges.len() >= MAX_EDGES {
                continuation.next_offset = None;
            }
        }
        let nodes = graph_nodes(&tx, &ids)?;
        tx.commit()?;
        Ok(ContextGraph {
            center,
            nodes,
            edges,
            omitted,
            omitted_groups: omitted_groups.into_iter().collect(),
            continuations: continuations.into_values().collect(),
            hidden_details,
            max_nodes: MAX_NODES,
            max_edges: MAX_EDGES,
            max_work: groups.len()
                * ((MAX_EXPANSIONS + 1) * (GROUP_LIMIT + 1)
                    + (MAX_NODES - 1) * (INDUCED_QUOTA + 1))
                + MAX_EXPANSIONS * (200 + GROUP_LIMIT + 1),
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
            "SELECT id, 'ticket', 'T-' || number || ' · ' || substr(title, 1, 200), status, trashed, 0, 'T-' || number FROM tickets WHERE id IN ({placeholders}) UNION ALL SELECT d.id, 'document', {}, NULL, d.trashed, d.originating_activity_id IS NOT NULL AND NOT d.kept, NULL FROM documents d WHERE d.id IN ({placeholders}) UNION ALL SELECT id, 'plan', substr(name, 1, 200), CASE WHEN archived THEN 'Archived' ELSE 'Active' END, 0, 0, NULL FROM plans WHERE id IN ({placeholders})",
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
                        ticket_reference: r.get(6)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?,
        );
    }
    nodes.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(nodes)
}

/// A bounded page of workspace candidates. The cursor advances through the
/// underlying identities even when filters reject every candidate in a page.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct WorkspaceGraphRequest {
    pub cursor: Option<String>,
    pub search: Option<String>,
    pub kind: Option<String>,
    pub tag: Option<String>,
    pub relationship: Option<String>,
    pub include_details: bool,
    pub adjacency_limit: usize,
    pub visible_ids: Vec<String>,
    pub hydrate_only: bool,
}

#[derive(Debug, Serialize)]
pub struct WorkspaceGraph {
    pub node_tags: BTreeMap<String, String>,
    pub nodes: Vec<ContextGraphNode>,
    pub edges: Vec<ContextGraphEdge>,
    pub next_cursor: Option<String>,
    pub omitted: bool,
    pub omitted_groups: Vec<String>,
}

impl Workspace {
    pub fn workspace_graph(
        &self,
        request: &WorkspaceGraphRequest,
    ) -> Result<WorkspaceGraph, Error> {
        let tx = self.connection.unchecked_transaction()?;
        let visible_truncated = request.visible_ids.len() > 100;
        let mut ids: BTreeSet<String> = request.visible_ids.iter().take(100).cloned().collect();
        let remaining = 100_usize.saturating_sub(ids.len()).min(50);
        let mut candidates = if request.hydrate_only {
            Vec::new()
        } else {
            let mut stmt = tx.prepare("SELECT id FROM entities WHERE id > ?1 AND kind IN ('ticket','document','plan') ORDER BY id LIMIT ?2")?;
            stmt.query_map(
                params![
                    request.cursor.as_deref().unwrap_or(""),
                    (remaining + 1) as i64
                ],
                |row| row.get::<_, String>(0),
            )?
            .collect::<Result<Vec<_>, _>>()?
        };
        let more = candidates.len() > remaining;
        candidates.truncate(remaining);
        let next_cursor = if more {
            candidates
                .last()
                .cloned()
                .or_else(|| request.cursor.clone())
        } else {
            None
        };
        ids.extend(candidates);
        if let Some(search) = request.search.as_deref().filter(|s| !s.trim().is_empty()) {
            let phrase = format!("\"{}\"", search.replace('"', "\"\""));
            let mut matches = BTreeSet::new();
            for (table, fts) in [
                ("tickets", "ticket_graph_fts"),
                ("documents", "document_fts"),
                ("plans", "plan_graph_fts"),
            ] {
                if ids.is_empty() {
                    break;
                }
                let placeholders = vec!["?"; ids.len()].join(",");
                let sql = format!(
                    "SELECT {table}.id FROM {table} CROSS JOIN {fts} ON {fts}.rowid = {table}.rowid WHERE {table}.id IN ({placeholders}) AND {fts} MATCH ?"
                );
                let mut stmt = tx.prepare(&sql)?;
                let params = ids
                    .iter()
                    .map(String::as_str)
                    .chain(std::iter::once(phrase.as_str()));
                matches.extend(
                    stmt.query_map(rusqlite::params_from_iter(params), |row| {
                        row.get::<_, String>(0)
                    })?
                    .collect::<Result<Vec<_>, _>>()?,
                );
            }
            ids.retain(|id| matches.contains(id));
        }
        if let Some(tag) = request.tag.as_deref().filter(|s| !s.is_empty()) {
            let tag = tag.trim().to_lowercase();
            let mut tagged = BTreeSet::new();
            for (table, column) in [
                ("ticket_tags", "ticket_id"),
                ("document_tags", "document_id"),
            ] {
                if ids.is_empty() {
                    break;
                }
                let placeholders = vec!["?"; ids.len()].join(",");
                let sql = format!(
                    "SELECT {column} FROM {table} WHERE {column} IN ({placeholders}) AND tag_name = ?"
                );
                let mut stmt = tx.prepare(&sql)?;
                let params = ids
                    .iter()
                    .map(String::as_str)
                    .chain(std::iter::once(tag.as_str()));
                tagged.extend(
                    stmt.query_map(rusqlite::params_from_iter(params), |row| {
                        row.get::<_, String>(0)
                    })?
                    .collect::<Result<Vec<_>, _>>()?,
                );
            }
            ids.retain(|id| tagged.contains(id));
        }
        let mut nodes = graph_nodes(&tx, &ids)?;
        nodes.retain(|node| {
            ids.contains(&node.id)
                && (request.include_details || !node.activity_detail)
                && request.kind.as_deref().is_none_or(|kind| kind == node.kind)
        });
        ids = nodes.iter().map(|node| node.id.clone()).collect();
        let anchors: Vec<_> = ids.iter().cloned().collect();
        let mut node_tags = BTreeMap::new();
        if !anchors.is_empty() {
            let placeholders = vec!["?"; anchors.len()].join(",");
            let sql = format!(
                "SELECT e.id, coalesce((SELECT tag_name FROM ticket_tags WHERE ticket_id=e.id ORDER BY tag_name LIMIT 1), (SELECT tag_name FROM document_tags WHERE document_id=e.id ORDER BY tag_name LIMIT 1)) FROM entities e WHERE e.id IN ({placeholders})"
            );
            let mut stmt = tx.prepare(&sql)?;
            for row in stmt.query_map(rusqlite::params_from_iter(&anchors), |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            })? {
                let (id, tag) = row?;
                if let Some(tag) = tag {
                    node_tags.insert(
                        id,
                        request
                            .tag
                            .as_ref()
                            .map_or(tag, |t| t.trim().to_lowercase()),
                    );
                }
            }
        }
        let mut edges = Vec::new();
        let mut seen = BTreeSet::new();
        let mut omitted_groups = BTreeSet::new();
        let adjacency_limit = request.adjacency_limit.clamp(3, 12);
        for (sql, kind) in GROUPS {
            if request
                .relationship
                .as_deref()
                .is_some_and(|filter| filter != kind)
                || anchors.is_empty()
            {
                continue;
            }
            let term = format!(
                "SELECT ? AS anchor, * FROM ({})",
                sql.replace("?1", "?")
                    .replace("?2", &(adjacency_limit + 1).to_string())
            );
            let query = vec![term; anchors.len()].join(" UNION ALL ");
            let mut stmt = tx.prepare(&query)?;
            let parameters = anchors.iter().flat_map(|anchor| [anchor, anchor]);
            let rows = stmt
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
                if *count > adjacency_limit {
                    omitted_groups.insert(kind.to_owned());
                    continue;
                }
                if !ids.contains(&source) || !ids.contains(&target) {
                    omitted_groups.insert(kind.to_owned());
                    continue;
                }
                let edge_kind = if kind == "document" && explanation.is_some() {
                    "spec"
                } else {
                    kind
                };
                if !seen.insert((
                    source.clone(),
                    target.clone(),
                    edge_kind.to_owned(),
                    explanation.clone(),
                )) {
                    continue;
                }
                if edges.len() == MAX_EDGES {
                    omitted_groups.insert(kind.to_owned());
                    continue;
                }
                edges.push(ContextGraphEdge {
                    source,
                    target,
                    kind: edge_kind.to_owned(),
                    explanation,
                });
            }
        }
        tx.commit()?;
        Ok(WorkspaceGraph {
            node_tags,
            nodes,
            edges,
            next_cursor,
            omitted: more || visible_truncated || !omitted_groups.is_empty(),
            omitted_groups: omitted_groups.into_iter().collect(),
        })
    }
}
