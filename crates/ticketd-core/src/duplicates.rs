use crate::readiness::{self, Readiness, unresolved_blockers};
use crate::{Error, Status, Ticket, Workspace, history, relationships};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// Whether a review cancels its source as a duplicate or only moves dependencies
/// (a separate dependency review, after the duplicate link was removed).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewMode {
    Duplicate,
    Separate,
}

impl std::fmt::Display for ReviewMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Duplicate => "duplicate",
            Self::Separate => "separate dependency",
        })
    }
}

/// One dependency of the source and where each choice would put it.
///
/// `mode`, `basis` and `replacement_basis` are stamped by the preview and must be submitted
/// unchanged. `basis` is an opaque fingerprint of the readiness inputs of Remove and Keep:
/// the edges, and the status, trash state and hold of each dependent and of its blockers.
/// `replacement_basis` fingerprints what only Replace depends on: the status and trash
/// state of the replacement endpoints and the blockers of the replacement dependent. It is
/// compared only for Replace decisions, so a Remove-only review does not go stale when the
/// canonical changes. Applying with a different fingerprint is a stale review; edits to
/// unrelated tickets change neither. Whether a Replace is still possible (a new cycle, a
/// trashed endpoint) is not in the fingerprints; it is re-checked on evaluate and apply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DependencyEdge {
    pub blocker: String,
    pub dependent: String,
    pub replacement_blocker: String,
    pub replacement_dependent: String,
    pub mode: ReviewMode,
    pub basis: String,
    pub replacement_basis: String,
}

/// A ticket that waits on one of the review's dependencies, as it is when previewed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WaitingTicket {
    pub ticket: String,
    pub status: Status,
    pub trashed: bool,
    pub readiness: Readiness,
    /// Blockers that are not Done now.
    pub unresolved: Vec<String>,
}

/// What a whole set of choices does to one ticket that waits on a blocker.
/// The waiting tickets are the edges' dependents and, for Replace, their replacements
/// (so the canonical appears when the duplicate itself is a dependent).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WaitingOutcome {
    pub ticket: String,
    /// The ticket's status now, before any choice is applied.
    pub status: Status,
    pub trashed: bool,
    pub before: Readiness,
    pub after: Readiness,
    /// Blockers that still have to be Done after every choice is applied.
    pub unresolved_after: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DependencyChoice {
    Replace,
    Remove,
    Retain,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DependencyDecision {
    pub edge: DependencyEdge,
    pub choice: DependencyChoice,
}
/// Why replacing an edge's duplicate endpoint with the canonical ticket is not possible.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplacementIssue {
    AlreadyExists,
    SelfBlock,
    Cycle,
    /// An endpoint of the replacement is in the trash, so the dependency cannot be added.
    Trashed,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DuplicateDependencyPreview {
    /// The source in its normalized form, which edges refer to.
    pub source: String,
    pub mode: ReviewMode,
    pub canonical: String,
    pub edges: Vec<DependencyEdge>,
    /// Each dependent of an edge with its current status and readiness, from the same
    /// snapshot as the edges. What each choice would change is answered by evaluating.
    #[serde(default)]
    pub waiting: Vec<WaitingTicket>,
    /// Parallel to `edges`: the reason Replace is invalid for that edge, if any.
    #[serde(default)]
    pub replacement_issues: Vec<Option<ReplacementIssue>>,
}

pub(crate) fn migrate(conn: &Connection) -> Result<(), Error> {
    conn.execute_batch("CREATE TABLE duplicate_tickets (source_id TEXT PRIMARY KEY REFERENCES tickets(id), canonical_id TEXT NOT NULL REFERENCES tickets(id), restore_status TEXT); PRAGMA user_version = 15;")?;
    Ok(())
}

/// Step 21: a duplicate is the dedicated Duplicate status, not Canceled plus a link.
///
/// Rows still Canceled become Duplicate; a row with no remembered status (its status was
/// changed on its own earlier) keeps Canceled as the status undo returns to. Rows whose
/// status moved on keep that chosen status and lose the relationship, as leaving
/// Duplicate does now. Every change is recorded in history.
pub(crate) fn migrate_status(conn: &Connection) -> Result<(), Error> {
    let mut stmt = conn.prepare("SELECT d.source_id, d.canonical_id, t.status FROM duplicate_tickets d JOIN tickets t ON t.id = d.source_id")?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    for (source, canonical, status) in rows {
        if status == "Canceled" {
            conn.execute(
                "UPDATE tickets SET status = 'Duplicate' WHERE id = ?1",
                [&source],
            )?;
            conn.execute("UPDATE duplicate_tickets SET restore_status = COALESCE(restore_status, 'Canceled') WHERE source_id = ?1", [&source])?;
            conn.execute("INSERT INTO ticket_history (ticket_id, kind, from_value, to_value) VALUES (?1, 'status', 'Canceled', 'Duplicate')", [&source])?;
        } else {
            let reference: String = conn.query_row(
                "SELECT reference FROM tickets WHERE id = ?1",
                [&canonical],
                |r| r.get(0),
            )?;
            conn.execute(
                "DELETE FROM duplicate_tickets WHERE source_id = ?1",
                [&source],
            )?;
            conn.execute("INSERT INTO ticket_history (ticket_id, kind, from_value, to_value) VALUES (?1, 'relationship:duplicate', ?2, '')", params![source, reference])?;
        }
    }
    conn.execute_batch("PRAGMA user_version = 21;")?;
    Ok(())
}

/// Remove the canonical designation of a ticket that is leaving Duplicate by choosing
/// another status. The chosen status stays.
pub(crate) fn clear(conn: &Connection, id: &str, agent: Option<&str>) -> Result<(), Error> {
    // A taken-over ticket keeps the source's last canonical as provenance only
    // while it stays Duplicate. What it was is written to history first, so
    // leaving Duplicate never erases it without a trace.
    let external: Option<String> = conn
        .query_row(
            "SELECT locator FROM external_duplicate_targets WHERE ticket_id = ?1",
            [id],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    if let Some(display) = external {
        history::record(conn, id, "external_duplicate", &display, "", agent)?;
    }
    conn.execute(
        "DELETE FROM external_duplicate_targets WHERE ticket_id = ?1",
        [id],
    )?;
    let canonical: Option<String> = conn.query_row("SELECT t.reference FROM duplicate_tickets d JOIN tickets t ON t.id = d.canonical_id WHERE d.source_id = ?1", [id], |r| r.get(0)).optional()?;
    if let Some(canonical) = canonical {
        conn.execute("DELETE FROM duplicate_tickets WHERE source_id = ?1", [id])?;
        history::record(conn, id, "relationship:duplicate", &canonical, "", agent)?;
    }
    Ok(())
}

/// The ticket that really is the original behind `canonical_id`: a local canonical
/// is already final; one that became a Duplicate through its source follows that
/// source's canonical (a ticket once imported, however far the chain goes). A
/// canonical whose own target is unknown, not a ticket, or loops is refused, so a
/// Duplicate never ends up pointing at another Duplicate.
fn final_canonical(conn: &Connection, canonical_id: &str) -> Result<String, Error> {
    let local: Option<String> = conn
        .query_row(
            "SELECT canonical_id FROM duplicate_tickets WHERE source_id = ?1",
            [canonical_id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(local) = local {
        return Ok(local);
    }
    let Some(target) = crate::source::duplicate_target(conn, canonical_id)? else {
        return Ok(canonical_id.to_owned());
    };
    let status: String = conn.query_row(
        "SELECT status FROM tickets WHERE id = ?1",
        [canonical_id],
        |r| r.get(0),
    )?;
    if status != Status::Duplicate.to_string() {
        return Ok(canonical_id.to_owned());
    }
    match target {
        crate::source::DuplicateTarget::External {
            ticket: Some(reference),
            ..
        } => relationships::id(conn, &reference),
        _ => {
            let reference: String = conn.query_row(
                "SELECT reference FROM tickets WHERE id = ?1",
                [canonical_id],
                |r| r.get(0),
            )?;
            Err(Error::DuplicateCanonicalUnresolved(reference))
        }
    }
}

pub(crate) fn populate(conn: &Connection, ticket: &mut Ticket) -> Result<(), Error> {
    ticket.duplicate_redirect = None;
    let direct: Option<String> = conn
        .query_row(
            "SELECT canonical_id FROM duplicate_tickets WHERE source_id = ?1",
            [&ticket.id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(direct) = direct
        && let Ok(resolved) = final_canonical(conn, &direct)
        && resolved != direct
    {
        ticket.duplicate_redirect = Some(conn.query_row(
            "SELECT reference FROM tickets WHERE id = ?1",
            [&resolved],
            |r| r.get(0),
        )?);
    }
    ticket.duplicate_of = conn.query_row("SELECT t.reference FROM duplicate_tickets d JOIN tickets t ON t.id = d.canonical_id WHERE d.source_id = ?1", [&ticket.id], |r| r.get(0)).optional()?;
    let mut stmt = conn.prepare("SELECT t.reference FROM duplicate_tickets d JOIN tickets t ON t.id = d.source_id WHERE d.canonical_id = ?1 ORDER BY t.number")?;
    ticket.duplicates = stmt
        .query_map([&ticket.id], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    Ok(())
}

impl Workspace {
    pub fn mark_duplicate(
        &mut self,
        source: &str,
        canonical: &str,
        agent: Option<&str>,
    ) -> Result<Ticket, Error> {
        self.mark_duplicate_internal(source, canonical, agent, false)
    }

    fn mark_duplicate_internal(
        &mut self,
        source: &str,
        canonical: &str,
        agent: Option<&str>,
        reviewed: bool,
    ) -> Result<Ticket, Error> {
        crate::write_scope::run(&self.connection, |tx| {
            let source_id = tx.even_if_trashed(source)?;
            let canonical_id = tx.even_if_trashed(canonical)?;
            tx.ensure_editable(&source_id)?;
            crate::source::guard_duplicate(tx, &source_id, source)?;
            tx.ensure_editable(&canonical_id)?;
            let destination = final_canonical(tx, &canonical_id)?;
            tx.ensure_editable(&destination)?;
            if source_id == canonical_id || source_id == destination {
                return Err(Error::DuplicateCycle);
            }
            let incident: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM dependencies WHERE blocker_id = ?1 OR dependent_id = ?1)",
            [&source_id],
            |r| r.get(0),
        )?;
            if incident && !reviewed {
                return Err(Error::DuplicateDependencies);
            }
            let status: String = tx.query_row(
                "SELECT status FROM tickets WHERE id = ?1",
                [&source_id],
                |r| r.get(0),
            )?;
            let previous: Option<String> = tx.query_row("SELECT t.reference FROM duplicate_tickets d JOIN tickets t ON t.id = d.canonical_id WHERE d.source_id = ?1", [&source_id], |r| r.get(0)).optional()?;
            let target: String = tx.query_row(
                "SELECT reference FROM tickets WHERE id = ?1",
                [&destination],
                |r| r.get(0),
            )?;
            if previous.as_deref() != Some(&target) {
                let mut stmt = tx.prepare("SELECT t.id, t.reference FROM duplicate_tickets d JOIN tickets t ON t.id = d.source_id WHERE d.canonical_id = ?1")?;
                let children = stmt
                    .query_map([&source_id], |r| {
                        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                drop(stmt);
                tx.execute(
                    "UPDATE duplicate_tickets SET canonical_id = ?1 WHERE canonical_id = ?2",
                    params![destination, source_id],
                )?;
                for (id, _) in children {
                    history::record(tx, &id, "relationship:duplicate", source, &target, agent)?;
                }
                tx.execute("INSERT INTO duplicate_tickets (source_id, canonical_id, restore_status) VALUES (?1, ?2, ?3) ON CONFLICT(source_id) DO UPDATE SET canonical_id = excluded.canonical_id", params![source_id, destination, status])?;
                history::record(
                    tx,
                    &source_id,
                    "relationship:duplicate",
                    previous.as_deref().unwrap_or(""),
                    &target,
                    agent,
                )?;
            }
            if status != "Duplicate" {
                tx.execute(
                    "UPDATE tickets SET status = 'Duplicate' WHERE id = ?1",
                    [&source_id],
                )?;
                history::record(tx, &source_id, "status", &status, "Duplicate", agent)?;
            }
            crate::read_ticket(tx, source)
        })
    }

    pub fn remove_duplicate(&mut self, source: &str, agent: Option<&str>) -> Result<Ticket, Error> {
        crate::write_scope::run(&self.connection, |tx| {
            let id = tx.editable(source)?;
            crate::source::guard_duplicate(tx, &id, source)?;
            let existing: Option<(Option<String>, String, String)> = tx.query_row("SELECT d.restore_status, c.reference, s.status FROM duplicate_tickets d JOIN tickets c ON c.id = d.canonical_id JOIN tickets s ON s.id = d.source_id WHERE d.source_id = ?1", [&id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional()?;
            if let Some((restore, canonical, status)) = existing {
                tx.execute("DELETE FROM duplicate_tickets WHERE source_id = ?1", [&id])?;
                history::record(tx, &id, "relationship:duplicate", &canonical, "", agent)?;
                if let Some(restore) = restore.filter(|r| r != &status) {
                    tx.execute(
                        "UPDATE tickets SET status = ?1 WHERE id = ?2",
                        params![restore, id],
                    )?;
                    history::record(tx, &id, "status", &status, &restore, agent)?;
                }
            }
            crate::read_ticket(tx, source)
        })
    }
}

/// The graph around a review, read once: the edges and the facts the outcomes need.
struct Snapshot {
    mode: ReviewMode,
    source: String,
    destination: String,
    edges: Vec<DependencyEdge>,
    facts: HashMap<String, Facts>,
    /// Current blockers of every dependent and of every replacement dependent.
    blockers: BTreeMap<String, BTreeSet<String>>,
    dependents: BTreeSet<String>,
}

#[derive(Clone, Copy)]
struct Facts {
    status: Status,
    trashed: bool,
    /// Closed at the source for an unrecognized reason: neither Ready nor Blocked.
    held: bool,
}

/// Orders references by device code, then by counter (`T-KQ9` before `T-KQ10`).
fn number(reference: &str) -> (&str, i64) {
    let counter = reference.trim_start_matches(|c: char| !c.is_ascii_digit());
    (
        &reference[..reference.len() - counter.len()],
        counter.parse().unwrap_or(i64::MAX),
    )
}

fn by_number(references: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut sorted: Vec<_> = references.into_iter().collect();
    sorted.sort_by(|a, b| number(a).cmp(&number(b)));
    sorted
}

/// A stable 64-bit FNV-1a hash; a fingerprint only has to be equal for equal state.
fn fingerprint(text: &str) -> String {
    let hash = text.bytes().fold(0xcbf29ce484222325_u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
    });
    format!("{hash:016x}")
}

impl Snapshot {
    fn load(
        connection: &Connection,
        source: &str,
        canonical: &str,
        mode: ReviewMode,
    ) -> Result<Self, Error> {
        let source_id = relationships::id(connection, source)?;
        let canonical_id = relationships::id(connection, canonical)?;
        if source_id == canonical_id {
            return Err(Error::ReviewSameTicket);
        }
        let source: String = connection.query_row(
            "SELECT reference FROM tickets WHERE id=?1",
            [&source_id],
            |r| r.get(0),
        )?;
        let destination_id = final_canonical(connection, &canonical_id)?;
        let destination: String = connection.query_row(
            "SELECT reference FROM tickets WHERE id = ?1",
            [&destination_id],
            |r| r.get(0),
        )?;
        if mode == ReviewMode::Duplicate {
            // Marking the duplicate fails for these whatever the choices, so say so up front.
            if source_id == destination_id {
                return Err(Error::DuplicateCycle);
            }
            for id in [&source_id, &canonical_id, &destination_id] {
                crate::write_scope::ensure_editable(connection, id)?;
            }
        }
        // The cap is checked before any further work, so a huge review is cheap to refuse.
        let mut stmt = connection.prepare("SELECT b.reference, d.reference FROM dependencies e JOIN tickets b ON b.id=e.blocker_id JOIN tickets d ON d.id=e.dependent_id WHERE e.blocker_id=?1 OR e.dependent_id=?1 ORDER BY b.number,d.number LIMIT 1001")?;
        let pairs: Vec<(String, String)> = stmt
            .query_map([&source_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        drop(stmt);
        if pairs.len() > 1000 {
            return Err(Error::InvalidBatch(
                "dependency review exceeds 1000 edges".into(),
            ));
        }
        let moved = |reference: &str| {
            if reference == source {
                destination.clone()
            } else {
                reference.to_string()
            }
        };
        let mut edges: Vec<DependencyEdge> = pairs
            .into_iter()
            .map(|(blocker, dependent)| DependencyEdge {
                replacement_blocker: moved(&blocker),
                replacement_dependent: moved(&dependent),
                blocker,
                dependent,
                mode,
                basis: String::new(),
                replacement_basis: String::new(),
            })
            .collect();

        // Facts about every ticket the outcomes mention, each read once.
        let mut facts: HashMap<String, Facts> = HashMap::new();
        let mut blockers: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        let mut dependents = BTreeSet::new();
        let mut needed: BTreeSet<String> = BTreeSet::new();
        for edge in &edges {
            dependents.insert(edge.dependent.clone());
            blockers.entry(edge.dependent.clone()).or_default();
            blockers
                .entry(edge.replacement_dependent.clone())
                .or_default();
            needed.insert(edge.replacement_blocker.clone());
        }
        let mut blocker_stmt = connection.prepare(&format!("SELECT b.reference, b.status, b.trashed, {} FROM dependencies d JOIN tickets b ON b.id = d.blocker_id JOIN tickets w ON w.id = d.dependent_id WHERE w.reference = ?1", crate::source::held_sql("b.id")))?;
        for (waiting, set) in &mut blockers {
            let rows = blocker_stmt
                .query_map([waiting], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, bool>(2)?,
                        r.get::<_, bool>(3)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            for (reference, status, trashed, held) in rows {
                facts.insert(
                    reference.clone(),
                    Facts {
                        status: status.parse()?,
                        trashed,
                        held,
                    },
                );
                set.insert(reference);
            }
        }
        drop(blocker_stmt);
        let mut fact_stmt = connection.prepare(&format!(
            "SELECT status, trashed, {} FROM tickets WHERE reference = ?1",
            crate::source::held_sql("tickets.id")
        ))?;
        for reference in needed.iter().chain(blockers.keys()) {
            if facts.contains_key(reference) {
                continue;
            }
            let (status, trashed, held): (String, bool, bool) = fact_stmt
                .query_row([reference], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .optional()?
                .ok_or_else(|| Error::NotFound(reference.clone()))?;
            facts.insert(
                reference.clone(),
                Facts {
                    status: status.parse()?,
                    trashed,
                    held,
                },
            );
        }
        drop(fact_stmt);

        let mut snapshot = Snapshot {
            mode,
            source,
            destination,
            edges: Vec::new(),
            facts,
            blockers,
            dependents,
        };
        let basis = snapshot.basis(&edges)?;
        for edge in &mut edges {
            edge.basis = basis.clone();
            edge.replacement_basis = snapshot.replacement_basis(edge)?;
        }
        snapshot.edges = edges;
        Ok(snapshot)
    }

    fn fact(&self, reference: &str) -> Result<Facts, Error> {
        self.facts
            .get(reference)
            .copied()
            .ok_or_else(|| Error::NotFound(reference.into()))
    }

    fn blockers_of(&self, waiting: &str) -> Result<&BTreeSet<String>, Error> {
        self.blockers
            .get(waiting)
            .ok_or_else(|| Error::NotFound(waiting.into()))
    }

    fn fact_text(&self, reference: &str) -> Result<String, Error> {
        let facts = self.fact(reference)?;
        Ok(format!(
            "{reference}:{}:{}:{}",
            facts.status,
            u8::from(facts.trashed),
            u8::from(facts.held)
        ))
    }

    /// A ticket's own facts and those of each of its blockers: all its readiness depends on.
    fn waiting_text(&self, waiting: &str) -> Result<String, Error> {
        let mut text = format!("{}<", self.fact_text(waiting)?);
        for blocker in by_number(self.blockers_of(waiting)?.iter().cloned()) {
            text.push_str(&self.fact_text(&blocker)?);
            text.push(',');
        }
        Ok(text)
    }

    fn basis(&self, edges: &[DependencyEdge]) -> Result<String, Error> {
        let mut text = format!("{:?}|{}|{}", self.mode, self.source, self.destination);
        for edge in edges {
            text.push_str(&format!(
                "|{}>{}={}>{}",
                edge.blocker, edge.dependent, edge.replacement_blocker, edge.replacement_dependent
            ));
        }
        for dependent in by_number(self.dependents.iter().cloned()) {
            text.push('|');
            text.push_str(&self.waiting_text(&dependent)?);
        }
        Ok(fingerprint(&text))
    }

    fn replacement_basis(&self, edge: &DependencyEdge) -> Result<String, Error> {
        Ok(fingerprint(&format!(
            "{}|{}",
            self.fact_text(&edge.replacement_blocker)?,
            self.waiting_text(&edge.replacement_dependent)?
        )))
    }

    /// Whether `decisions` answer exactly this review: the same mode, edges and fingerprints.
    fn check(&self, decisions: &[DependencyDecision]) -> Result<(), Error> {
        if decisions.iter().any(|d| d.edge.mode != self.mode) {
            return Err(Error::DependencyReviewMode(self.mode));
        }
        let same = decisions.len() == self.edges.len()
            && decisions
                .iter()
                .zip(&self.edges)
                .all(|(decision, current)| {
                    let mut submitted = decision.edge.clone();
                    if decision.choice != DependencyChoice::Replace {
                        submitted.replacement_basis = current.replacement_basis.clone();
                    }
                    submitted == *current
                });
        if same {
            Ok(())
        } else {
            Err(Error::DependencyReviewChanged)
        }
    }

    /// The dependents as they are now.
    fn baseline(&self) -> Result<Vec<WaitingTicket>, Error> {
        by_number(self.dependents.iter().cloned())
            .into_iter()
            .map(|waiting| {
                let facts = self.fact(&waiting)?;
                let blockers = self
                    .blockers_of(&waiting)?
                    .iter()
                    .map(|b| Ok((b.clone(), self.fact(b)?.status)))
                    .collect::<Result<Vec<_>, Error>>()?;
                Ok(WaitingTicket {
                    readiness: readiness::judge(
                        facts.status,
                        facts.trashed,
                        facts.held,
                        blockers.iter().map(|(_, status)| *status),
                    ),
                    unresolved: by_number(unresolved_blockers(blockers)),
                    status: facts.status,
                    trashed: facts.trashed,
                    ticket: waiting,
                })
            })
            .collect()
    }

    /// Readiness of every waiting ticket before and after all of `decisions` are applied
    /// together; the duplicate has the Duplicate status afterwards.
    fn outcomes(&self, decisions: &[DependencyDecision]) -> Result<Vec<WaitingOutcome>, Error> {
        let mut after_blockers = self.blockers.clone();
        for decision in decisions {
            let edge = &decision.edge;
            if decision.choice != DependencyChoice::Retain
                && let Some(set) = after_blockers.get_mut(&edge.dependent)
            {
                set.remove(&edge.blocker);
            }
        }
        for decision in decisions {
            let edge = &decision.edge;
            if decision.choice == DependencyChoice::Replace {
                after_blockers
                    .entry(edge.replacement_dependent.clone())
                    .or_default()
                    .insert(edge.replacement_blocker.clone());
            }
        }
        let status_after = |reference: &str| -> Result<Status, Error> {
            if self.mode == ReviewMode::Duplicate && reference == self.source {
                Ok(Status::Duplicate)
            } else {
                Ok(self.fact(reference)?.status)
            }
        };
        let status_now =
            |reference: &str| -> Result<Status, Error> { Ok(self.fact(reference)?.status) };
        let judge = |waiting: &str,
                     blockers: &BTreeSet<String>,
                     status: &dyn Fn(&str) -> Result<Status, Error>|
         -> Result<(Readiness, Vec<String>), Error> {
            let facts = self.fact(waiting)?;
            let statuses = blockers
                .iter()
                .map(|b| Ok((b.clone(), status(b)?)))
                .collect::<Result<Vec<(String, Status)>, Error>>()?;
            Ok((
                readiness::judge(
                    status(waiting)?,
                    facts.trashed,
                    facts.held,
                    statuses.iter().map(|(_, status)| *status),
                ),
                unresolved_blockers(statuses),
            ))
        };
        by_number(self.blockers.keys().cloned())
            .into_iter()
            .map(|waiting| {
                let (before, _) = judge(&waiting, self.blockers_of(&waiting)?, &status_now)?;
                let after_set = after_blockers
                    .get(&waiting)
                    .ok_or_else(|| Error::NotFound(waiting.clone()))?;
                let (after, unresolved) = judge(&waiting, after_set, &status_after)?;
                let facts = self.fact(&waiting)?;
                Ok(WaitingOutcome {
                    status: facts.status,
                    trashed: facts.trashed,
                    ticket: waiting,
                    before,
                    after,
                    unresolved_after: by_number(unresolved),
                })
            })
            .collect()
    }
}

impl Workspace {
    pub fn preview_duplicate_dependencies(
        &self,
        source: &str,
        canonical: &str,
    ) -> Result<DuplicateDependencyPreview, Error> {
        self.preview_dependencies(source, canonical, ReviewMode::Duplicate)
    }

    /// Previews moving `source`'s dependencies to `canonical` without canceling `source`,
    /// as a separate dependency review does.
    pub fn preview_dependency_move(
        &self,
        source: &str,
        canonical: &str,
    ) -> Result<DuplicateDependencyPreview, Error> {
        self.preview_dependencies(source, canonical, ReviewMode::Separate)
    }

    fn preview_dependencies(
        &self,
        source: &str,
        canonical: &str,
        mode: ReviewMode,
    ) -> Result<DuplicateDependencyPreview, Error> {
        // One read transaction, so the edges, statuses and issues describe one moment.
        let tx = self.connection.unchecked_transaction()?;
        let snapshot = Snapshot::load(&tx, source, canonical, mode)?;
        let replacement_issues = snapshot
            .edges
            .iter()
            .map(|edge| self.replacement_issue(edge))
            .collect::<Result<_, _>>()?;
        Ok(DuplicateDependencyPreview {
            waiting: snapshot.baseline()?,
            source: snapshot.source,
            mode,
            canonical: snapshot.destination,
            edges: snapshot.edges,
            replacement_issues,
        })
    }

    /// What the whole set of `decisions` would do to each ticket that waits on one of the
    /// review's dependencies. The decisions must answer a current preview of the same mode;
    /// a mismatched mode or a changed review is an error rather than a misleading answer,
    /// and so is a Replace that can no longer be applied (a new cycle, a trashed endpoint),
    /// exactly as when applying.
    pub fn evaluate_dependency_review(
        &self,
        source: &str,
        canonical: &str,
        mode: ReviewMode,
        decisions: &[DependencyDecision],
    ) -> Result<Vec<WaitingOutcome>, Error> {
        let tx = self.connection.unchecked_transaction()?;
        let snapshot = Snapshot::load(&tx, source, canonical, mode)?;
        snapshot.check(decisions)?;
        self.ensure_replaceable(decisions)?;
        snapshot.outcomes(decisions)
    }

    /// A replacement that became impossible since the review was shown, through an unrelated
    /// change, is as stale as a changed edge.
    fn ensure_replaceable(&self, decisions: &[DependencyDecision]) -> Result<(), Error> {
        for decision in decisions {
            if decision.choice == DependencyChoice::Replace
                && self.replacement_issue(&decision.edge)?.is_some()
            {
                return Err(Error::DependencyReviewChanged);
            }
        }
        Ok(())
    }

    /// Judges the replacement against the graph without the edge it would replace.
    fn replacement_issue(&self, edge: &DependencyEdge) -> Result<Option<ReplacementIssue>, Error> {
        if edge.replacement_blocker == edge.replacement_dependent {
            return Ok(Some(ReplacementIssue::SelfBlock));
        }
        let blocker = relationships::id(&self.connection, &edge.replacement_blocker)?;
        let dependent = relationships::id(&self.connection, &edge.replacement_dependent)?;
        for id in [&blocker, &dependent] {
            let trashed: bool = self.connection.query_row(
                "SELECT trashed FROM tickets WHERE id = ?1",
                [id],
                |r| r.get(0),
            )?;
            if trashed {
                return Ok(Some(ReplacementIssue::Trashed));
            }
        }
        let exists: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM dependencies WHERE blocker_id = ?1 AND dependent_id = ?2)",
            params![blocker, dependent],
            |r| r.get(0),
        )?;
        if exists {
            return Ok(Some(ReplacementIssue::AlreadyExists));
        }
        let original_blocker = relationships::id(&self.connection, &edge.blocker)?;
        let original_dependent = relationships::id(&self.connection, &edge.dependent)?;
        let cycle = relationships::reaches(
            &self.connection,
            &dependent,
            &blocker,
            Some((&original_blocker, &original_dependent)),
        )?;
        Ok(cycle.then_some(ReplacementIssue::Cycle))
    }

    pub fn mark_duplicate_reviewed(
        &mut self,
        source: &str,
        canonical: &str,
        expected_canonical: &str,
        decisions: Vec<DependencyDecision>,
        agent: Option<&str>,
    ) -> Result<Ticket, Error> {
        // A savepoint composes with retryable writes, while acquiring the write lock before
        // reading ensures that the reviewed graph cannot change before commit.
        self.in_write_scope(|workspace| {
            workspace.apply_dependency_review(
                source,
                canonical,
                expected_canonical,
                &decisions,
                ReviewMode::Duplicate,
                agent,
            )?;
            workspace.mark_duplicate_internal(source, canonical, agent, true)
        })
    }
    pub fn edit_dependencies_reviewed(
        &mut self,
        source: &str,
        canonical: &str,
        expected_canonical: &str,
        decisions: Vec<DependencyDecision>,
        agent: Option<&str>,
    ) -> Result<Ticket, Error> {
        self.in_write_scope(|workspace| {
            workspace.apply_dependency_review(
                source,
                canonical,
                expected_canonical,
                &decisions,
                ReviewMode::Separate,
                agent,
            )?;
            workspace.show_ticket(source)
        })
    }

    fn apply_dependency_review(
        &mut self,
        source: &str,
        canonical: &str,
        expected_canonical: &str,
        decisions: &[DependencyDecision],
        mode: ReviewMode,
        agent: Option<&str>,
    ) -> Result<(), Error> {
        let snapshot = Snapshot::load(&self.connection, source, canonical, mode)?;
        snapshot.check(decisions)?;
        if expected_canonical != snapshot.destination {
            return Err(Error::DependencyReviewChanged);
        }
        self.ensure_replaceable(decisions)?;
        for decision in decisions {
            if decision.choice != DependencyChoice::Retain {
                self.remove_dependency(&decision.edge.blocker, &decision.edge.dependent, agent)?;
            }
        }
        for decision in decisions {
            if decision.choice == DependencyChoice::Replace {
                self.add_dependency(
                    &decision.edge.replacement_blocker,
                    &decision.edge.replacement_dependent,
                    agent,
                )?;
            }
        }
        Ok(())
    }
}
