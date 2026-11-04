use std::collections::{BTreeSet, HashMap};

use serde::Serialize;

use crate::{Error, Status, Workspace, relationships};

const MAX_NODES: usize = 50;
const MAX_DEPTH: usize = 2;
const MAX_EDGES: usize = 300;
const MAX_WORK: usize = 3000;
/// Outside tickets a Plan graph adds beyond its members, so a dense Plan still shows them.
const MAX_OUTSIDE: usize = 20;

#[derive(Debug, Serialize)]
pub struct GraphNode {
    pub id: String,
    pub trashed: bool,
    pub reference: String,
    pub title: String,
    pub status: Status,
    pub availability: Option<String>,
    pub boundary: bool,
    pub project_id: Option<String>,
}
#[derive(Debug, Serialize)]
pub struct GraphEdge {
    pub blocker: String,
    pub dependent: String,
}
#[derive(Debug, Serialize)]
pub struct DependencyGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub max_nodes: usize,
    pub max_depth: usize,
    pub max_edges: usize,
    pub max_work: usize,
    /// Some neighbors were omitted, or the work budget prevented checking them.
    pub omitted_neighbors: bool,
    /// Some edges between displayed nodes were omitted or could not be checked.
    pub omitted_edges: bool,
    pub truncated: bool,
    /// For a Plan graph, every non-trashed member, shown or not.
    pub total_members: Option<usize>,
}

impl Workspace {
    pub fn dependency_graph(&self, reference: &str) -> Result<DependencyGraph, Error> {
        let tx = self.connection.unchecked_transaction()?;
        let root = relationships::id(&tx, reference)?;
        let mut ids = vec![root.clone()];
        let mut depths = HashMap::from([(root.clone(), 0)]);
        let mut frontier = vec![root];
        let mut candidates = BTreeSet::new();
        let mut omitted_neighbors = false;
        let mut incomplete = false;
        let mut work = 0;
        for depth in 0..=MAX_DEPTH {
            if frontier.is_empty() {
                break;
            }
            // Each term is independently limited before the UNION. The two covering
            // indexes make the budget effective even for very high-degree tickets.
            let quota = (MAX_WORK - work) / (frontier.len() * 2);
            if quota == 0 {
                incomplete = true;
                break;
            }
            let mut terms = Vec::new();
            let mut parameters = Vec::new();
            for id in &frontier {
                for (column, other, outgoing) in [
                    ("blocker_id", "dependent_id", 1),
                    ("dependent_id", "blocker_id", 0),
                ] {
                    terms.push(format!("SELECT ? AS root, {outgoing} AS outgoing, neighbor FROM (SELECT {other} AS neighbor FROM dependencies WHERE {column} = ? ORDER BY {other} LIMIT {})", quota + 1));
                    parameters.push(id.clone());
                    parameters.push(id.clone());
                }
            }
            let mut statement = tx.prepare(&terms.join(" UNION ALL "))?;
            let rows = statement
                .query_map(rusqlite::params_from_iter(parameters), |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, bool>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(statement);
            let mut seen_per_direction: HashMap<(String, bool), usize> = HashMap::new();
            let mut next = Vec::new();
            for (id, outgoing, neighbor) in rows {
                let count = seen_per_direction
                    .entry((id.clone(), outgoing))
                    .or_default();
                *count += 1;
                if *count > quota {
                    incomplete = true;
                    continue;
                }
                work += 1;
                let edge = if outgoing {
                    (id.clone(), neighbor.clone())
                } else {
                    (neighbor.clone(), id.clone())
                };
                candidates.insert(edge);
                if let std::collections::hash_map::Entry::Vacant(entry) =
                    depths.entry(neighbor.clone())
                {
                    if depth == MAX_DEPTH || ids.len() == MAX_NODES {
                        omitted_neighbors = true;
                    } else {
                        entry.insert(depth + 1);
                        ids.push(neighbor.clone());
                        next.push(neighbor);
                    }
                }
            }
            frontier = next;
        }
        omitted_neighbors |= incomplete;
        let (nodes, references) = graph_nodes(&tx, &ids, &BTreeSet::new())?;
        let mut edges = Vec::new();
        let mut omitted_edges = incomplete;
        for (blocker, dependent) in candidates {
            if let (Some(blocker), Some(dependent)) =
                (references.get(&blocker), references.get(&dependent))
            {
                if edges.len() == MAX_EDGES {
                    omitted_edges = true;
                    break;
                }
                edges.push(GraphEdge {
                    blocker: blocker.clone(),
                    dependent: dependent.clone(),
                });
            }
        }
        tx.commit()?;
        Ok(DependencyGraph {
            nodes,
            edges,
            max_nodes: MAX_NODES,
            max_depth: MAX_DEPTH,
            max_edges: MAX_EDGES,
            max_work: MAX_WORK,
            omitted_neighbors,
            omitted_edges,
            truncated: omitted_neighbors || omitted_edges,
            total_members: None,
        })
    }
    /// A bounded Plan scope, including prerequisites just outside that scope.
    pub fn plan_dependency_graph(&self, plan: &str) -> Result<DependencyGraph, Error> {
        let tx = self.connection.unchecked_transaction()?;
        crate::plans::get(&tx, plan)?;
        let mut stmt = tx.prepare(
            "SELECT id FROM tickets WHERE plan_id = ?1 AND trashed = 0 ORDER BY number LIMIT ?2",
        )?;
        let mut ids = stmt
            .query_map(rusqlite::params![plan, MAX_NODES + 1], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);
        let total_members: usize = tx.query_row(
            "SELECT COUNT(*) FROM tickets WHERE plan_id = ?1 AND trashed = 0",
            [plan],
            |row| row.get(0),
        )?;
        let mut omitted_neighbors = ids.len() > MAX_NODES;
        ids.truncate(MAX_NODES);
        let members = ids.clone();
        let mut boundaries = BTreeSet::new();
        let mut candidates = BTreeSet::new();
        let mut incomplete = false;
        let quota = MAX_WORK / (members.len().max(1) * 2);
        if !members.is_empty() {
            // Prerequisites and tickets that wait on a member, both outside the Plan.
            let mut terms = Vec::new();
            let mut parameters = Vec::new();
            for id in &members {
                for (column, other, outgoing) in [
                    ("dependent_id", "blocker_id", 0),
                    ("blocker_id", "dependent_id", 1),
                ] {
                    terms.push(format!("SELECT ? AS member, {outgoing} AS outgoing, neighbor FROM (SELECT {other} AS neighbor FROM dependencies WHERE {column} = ? ORDER BY {other} LIMIT {})", quota + 1));
                    parameters.push(id);
                    parameters.push(id);
                }
            }
            let mut stmt = tx.prepare(&terms.join(" UNION ALL "))?;
            let rows = stmt
                .query_map(rusqlite::params_from_iter(parameters), |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, bool>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(stmt);
            let mut counts = HashMap::<(String, bool), usize>::new();
            for (member, outgoing, neighbor) in rows {
                let count = counts.entry((member.clone(), outgoing)).or_default();
                *count += 1;
                if *count > quota {
                    incomplete = true;
                    continue;
                }
                if !ids.contains(&neighbor) {
                    // A member past the node limit is omitted, not an outside ticket.
                    let in_plan = tx.query_row(
                        "SELECT plan_id IS ?2 FROM tickets WHERE id = ?1",
                        rusqlite::params![neighbor, plan],
                        |row| row.get::<_, bool>(0),
                    )?;
                    if in_plan {
                        omitted_neighbors = true;
                        continue;
                    }
                    if boundaries.len() == MAX_OUTSIDE {
                        omitted_neighbors = true;
                        continue;
                    }
                    boundaries.insert(neighbor.clone());
                    ids.push(neighbor.clone());
                }
                candidates.insert(if outgoing {
                    (member, neighbor)
                } else {
                    (neighbor, member)
                });
            }
        }
        let (nodes, references) = graph_nodes(&tx, &ids, &boundaries)?;
        let mut edges = Vec::new();
        let mut omitted_edges = incomplete;
        for (blocker, dependent) in candidates {
            if edges.len() == MAX_EDGES {
                omitted_edges = true;
                break;
            }
            if let (Some(blocker), Some(dependent)) =
                (references.get(&blocker), references.get(&dependent))
            {
                edges.push(GraphEdge {
                    blocker: blocker.clone(),
                    dependent: dependent.clone(),
                });
            }
        }
        omitted_neighbors |= incomplete;
        tx.commit()?;
        Ok(DependencyGraph {
            nodes,
            edges,
            max_nodes: MAX_NODES,
            max_depth: 1,
            max_edges: MAX_EDGES,
            max_work: MAX_WORK,
            omitted_neighbors,
            omitted_edges,
            truncated: omitted_neighbors || omitted_edges,
            total_members: Some(total_members),
        })
    }
}

fn graph_nodes(
    tx: &rusqlite::Connection,
    ids: &[String],
    boundaries: &BTreeSet<String>,
) -> Result<(Vec<GraphNode>, HashMap<String, String>), Error> {
    let ids_json = serde_json::to_string(&ids)?;
    let sql = format!(
        "SELECT t.id, t.number, t.title, t.status, t.trashed, {}, EXISTS(SELECT 1 FROM dependencies d JOIN tickets b ON b.id = d.blocker_id WHERE d.dependent_id = t.id AND {}), t.project_id FROM tickets t WHERE t.id IN (SELECT value FROM json_each(?1))",
        crate::source::held_sql("t.id"),
        crate::history::unresolved_blocker_sql("b")
    );
    let mut statement = tx.prepare(&sql)?;
    let rows = statement
        .query_map([ids_json], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, bool>(4)?,
                row.get::<_, bool>(5)?,
                row.get::<_, bool>(6)?,
                row.get::<_, Option<String>>(7)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    let mut metadata = HashMap::new();
    for (id, number, title, status, trashed, held, blocked, project_id) in rows {
        let status: Status = status.parse().map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(e))
        })?;
        let availability = if held || trashed || status != Status::Todo {
            None
        } else if blocked {
            Some("Blocked".into())
        } else {
            Some("Ready".into())
        };
        metadata.insert(
            id.clone(),
            GraphNode {
                id,
                trashed,
                reference: format!("T-{number}"),
                title,
                status,
                availability,
                boundary: false,
                project_id,
            },
        );
    }
    let mut nodes = Vec::new();
    let mut references = HashMap::new();
    for id in ids {
        if let Some(mut node) = metadata.remove(id) {
            node.boundary = boundaries.contains(id);
            references.insert(id.clone(), node.reference.clone());
            nodes.push(node);
        }
    }
    Ok((nodes, references))
}
