//! Merge rules for a record seen on two devices, independent of the file format.

use std::collections::{BTreeMap, BTreeSet};

/// One field of a synced record. A set merges by membership; a value is compared whole.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Field {
    Value(String),
    Set(BTreeSet<String>),
}

/// A record as field name to field. A missing name means the field is unset.
pub type Fields = BTreeMap<String, Field>;

/// A field both sides changed to different values since the last-synced copy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conflict {
    pub field: String,
    pub base: Option<Field>,
    pub local: Option<Field>,
    pub remote: Option<Field>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Merged {
    /// The record to keep locally. A conflicting field holds the local value.
    pub fields: Fields,
    /// In field-name order.
    pub conflicts: Vec<Conflict>,
}

/// Three-way merge of `local` and `remote` against `base`, the last-synced copy.
///
/// A field only one side changed takes that side's value. Sets combine each
/// side's additions and removals, and an addition wins over a removal. Anything
/// else both sides changed differently keeps the local value and is reported.
pub fn merge(base: &Fields, local: &Fields, remote: &Fields) -> Merged {
    let names: BTreeSet<&String> = base
        .keys()
        .chain(local.keys())
        .chain(remote.keys())
        .collect();
    let mut fields = Fields::new();
    let mut conflicts = Vec::new();
    for name in names {
        let (b, l, r) = (base.get(name), local.get(name), remote.get(name));
        let merged = if l == r || r == b {
            l.cloned()
        } else if l == b {
            r.cloned()
        } else if let (Some(Field::Set(l)), Some(Field::Set(r)), None | Some(Field::Set(_))) =
            (l, r, b)
        {
            let empty = BTreeSet::new();
            let b = match b {
                Some(Field::Set(b)) => b,
                _ => &empty,
            };
            // Kept by both, or added by either: an addition is never undone by the other side.
            Some(Field::Set(
                l.union(r)
                    .filter(|item| !b.contains(*item) || (l.contains(*item) && r.contains(*item)))
                    .cloned()
                    .collect(),
            ))
        } else {
            conflicts.push(Conflict {
                field: name.clone(),
                base: b.cloned(),
                local: l.cloned(),
                remote: r.cloned(),
            });
            l.cloned()
        };
        if let Some(field) = merged {
            fields.insert(name.clone(), field);
        }
    }
    Merged { fields, conflicts }
}

/// One `blocked_by` relationship. `order` is the key every device computes
/// identically for the edge (for example its creation time); ties fall back to
/// the two GUIDs, so the order is total.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct BlockedBy {
    pub order: String,
    pub blocked: String,
    pub blocker: String,
}

/// The edges to drop so that no ticket blocks itself through a loop.
///
/// Edges are taken earliest first and one that would close a loop is dropped,
/// so the result depends only on the set of edges: every device holding the
/// same edges drops the same later ones, whatever order it learned them in.
pub fn loop_edges(edges: &[BlockedBy]) -> Vec<BlockedBy> {
    let ordered: BTreeSet<&BlockedBy> = edges.iter().collect();
    let mut blockers: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    let mut dropped = Vec::new();
    for edge in ordered {
        // ponytail: one graph walk per edge, O(E * (V + E)); keep a topological
        // order instead if a Workspace ever holds enough dependencies to notice.
        if reaches(&blockers, &edge.blocker, &edge.blocked) {
            dropped.push(edge.clone());
        } else {
            blockers
                .entry(&edge.blocked)
                .or_default()
                .push(&edge.blocker);
        }
    }
    dropped
}

/// Whether `target` is `from` or blocks it, directly or through other tickets.
fn reaches(blockers: &BTreeMap<&str, Vec<&str>>, from: &str, target: &str) -> bool {
    let mut seen = BTreeSet::new();
    let mut pending = vec![from];
    while let Some(ticket) = pending.pop() {
        if ticket == target {
            return true;
        }
        if seen.insert(ticket) {
            pending.extend(blockers.get(ticket).into_iter().flatten());
        }
    }
    false
}
