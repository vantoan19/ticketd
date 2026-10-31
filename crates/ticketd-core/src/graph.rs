use std::collections::{HashMap, VecDeque};

use rusqlite::{OptionalExtension, params};
use serde::Serialize;

use crate::{Error, Status, Workspace, relationships};

const MAX_NODES: usize = 50;
const MAX_DEPTH: usize = 2;

#[derive(Debug, Serialize)]
pub struct GraphNode {
    pub id: String,
    pub trashed: bool,
    pub reference: String,
    pub title: String,
    pub status: Status,
    pub availability: Option<String>,
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
    pub truncated: bool,
}

impl Workspace {
    pub fn dependency_graph(&self, reference: &str) -> Result<DependencyGraph, Error> {
        let tx = self.connection.unchecked_transaction()?;
        let root = relationships::id(&tx, reference)?;
        let mut ids = vec![root.clone()];
        let mut depths = HashMap::from([(root.clone(), 0)]);
        let mut queue = VecDeque::from([root]);
        let mut truncated = false;
        while let Some(id) = queue.pop_front() {
            let depth = depths[&id];
            let mut statement = tx.prepare("SELECT t.id FROM tickets t JOIN dependencies d ON (d.blocker_id = ?1 AND t.id = d.dependent_id) OR (d.dependent_id = ?1 AND t.id = d.blocker_id) ORDER BY t.number LIMIT 51")?;
            let neighbors = statement
                .query_map([&id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            for neighbor in neighbors {
                if depths.contains_key(&neighbor) {
                    continue;
                }
                if depth == MAX_DEPTH || ids.len() == MAX_NODES {
                    truncated = true;
                    continue;
                }
                depths.insert(neighbor.clone(), depth + 1);
                ids.push(neighbor.clone());
                queue.push_back(neighbor);
            }
        }
        let mut nodes = Vec::new();
        for id in &ids {
            let (number, title, status, blocked, trashed): (i64, String, String, bool, bool) = tx.query_row(&format!("SELECT number, title, status, EXISTS(SELECT 1 FROM dependencies d JOIN tickets b ON b.id = d.blocker_id WHERE d.dependent_id = tickets.id AND {}), trashed FROM tickets WHERE id = ?1", crate::history::unresolved_blocker_sql("b")), [id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)))?;
            let status: Status = status.parse().map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    2,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })?;
            nodes.push(GraphNode {
                id: id.clone(),
                trashed,
                reference: format!("T-{number}"),
                title,
                status,
                availability: if status == Status::Todo {
                    Some(if blocked { "Blocked" } else { "Ready" }.into())
                } else {
                    None
                },
            });
        }
        let mut edges = Vec::new();
        let mut statement =
            tx.prepare("SELECT 1 FROM dependencies WHERE blocker_id = ?1 AND dependent_id = ?2")?;
        for (i, blocker) in ids.iter().enumerate() {
            for (j, dependent) in ids.iter().enumerate() {
                if statement
                    .query_row(params![blocker, dependent], |_| Ok(()))
                    .optional()?
                    .is_some()
                {
                    edges.push(GraphEdge {
                        blocker: nodes[i].reference.clone(),
                        dependent: nodes[j].reference.clone(),
                    });
                }
            }
        }
        drop(statement);
        tx.commit()?;
        Ok(DependencyGraph {
            nodes,
            edges,
            max_nodes: MAX_NODES,
            max_depth: MAX_DEPTH,
            truncated,
        })
    }
}
