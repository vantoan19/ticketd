use crate::{Error, Status, Ticket, Workspace, history, relationships};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DependencyEdge {
    pub blocker: String,
    pub dependent: String,
    pub replacement_blocker: String,
    pub replacement_dependent: String,
    /// The dependent's status when the review was built.
    pub dependent_status: Status,
    /// Whether the dependent is Ready now: Todo with every blocker Done.
    pub dependent_ready: bool,
    /// Whether the waiting ticket would be Ready after each choice, by the same blocker rule
    /// as everywhere else. The waiting ticket is the dependent, except that Replace moves the
    /// edge to `replacement_dependent`. The duplicate counts as Canceled in a duplicate review.
    pub ready_if_replaced: bool,
    pub ready_if_removed: bool,
    pub ready_if_kept: bool,
}
// The edge is what a review must still match when applied, so these live fields make a
// status change in the dependent or its other blockers a stale review.
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
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DuplicateDependencyPreview {
    pub canonical: String,
    pub edges: Vec<DependencyEdge>,
    /// Parallel to `edges`: the reason Replace is invalid for that edge, if any.
    #[serde(default)]
    pub replacement_issues: Vec<Option<ReplacementIssue>>,
}

/// Which ticket a review cancels, for judging readiness after its choices.
struct ReadinessView<'a> {
    source_id: &'a str,
    source_canceled: bool,
}

pub(crate) fn migrate(conn: &Connection) -> Result<(), Error> {
    conn.execute_batch("CREATE TABLE duplicate_tickets (source_id TEXT PRIMARY KEY REFERENCES tickets(id), canonical_id TEXT NOT NULL REFERENCES tickets(id), restore_status TEXT); PRAGMA user_version = 15;")?;
    Ok(())
}

pub(crate) fn populate(conn: &Connection, ticket: &mut Ticket) -> Result<(), Error> {
    ticket.duplicate_of = conn.query_row("SELECT 'T-' || t.number FROM duplicate_tickets d JOIN tickets t ON t.id = d.canonical_id WHERE d.source_id = ?1", [&ticket.id], |r| r.get(0)).optional()?;
    let mut stmt = conn.prepare("SELECT 'T-' || t.number FROM duplicate_tickets d JOIN tickets t ON t.id = d.source_id WHERE d.canonical_id = ?1 ORDER BY t.number")?;
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
        let tx = self.connection.savepoint()?;
        crate::transaction_write_lock(&tx)?;
        let source_id = relationships::id(&tx, source)?;
        let canonical_id = relationships::id(&tx, canonical)?;
        crate::ensure_editable(&tx, &source_id)?;
        crate::ensure_editable(&tx, &canonical_id)?;
        let destination: String = tx.query_row("SELECT COALESCE((SELECT canonical_id FROM duplicate_tickets WHERE source_id = ?1), ?1)", [&canonical_id], |r| r.get(0))?;
        crate::ensure_editable(&tx, &destination)?;
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
        let previous: Option<String> = tx.query_row("SELECT 'T-' || t.number FROM duplicate_tickets d JOIN tickets t ON t.id = d.canonical_id WHERE d.source_id = ?1", [&source_id], |r| r.get(0)).optional()?;
        let target: String = tx.query_row(
            "SELECT 'T-' || number FROM tickets WHERE id = ?1",
            [&destination],
            |r| r.get(0),
        )?;
        if previous.as_deref() != Some(&target) {
            let mut stmt = tx.prepare("SELECT t.id, 'T-' || t.number FROM duplicate_tickets d JOIN tickets t ON t.id = d.source_id WHERE d.canonical_id = ?1")?;
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
                history::record(&tx, &id, "relationship:duplicate", source, &target, agent)?;
            }
            tx.execute("INSERT INTO duplicate_tickets (source_id, canonical_id, restore_status) VALUES (?1, ?2, ?3) ON CONFLICT(source_id) DO UPDATE SET canonical_id = excluded.canonical_id", params![source_id, destination, status])?;
            history::record(
                &tx,
                &source_id,
                "relationship:duplicate",
                previous.as_deref().unwrap_or(""),
                &target,
                agent,
            )?;
        }
        if status != "Canceled" {
            tx.execute(
                "UPDATE tickets SET status = 'Canceled' WHERE id = ?1",
                [&source_id],
            )?;
            history::record(&tx, &source_id, "status", &status, "Canceled", agent)?;
        }
        tx.commit()?;
        self.show_ticket(source)
    }

    pub fn remove_duplicate(&mut self, source: &str, agent: Option<&str>) -> Result<Ticket, Error> {
        let tx = self.connection.savepoint()?;
        crate::transaction_write_lock(&tx)?;
        let id = relationships::id(&tx, source)?;
        crate::ensure_editable(&tx, &id)?;
        let existing: Option<(Option<String>, String, String)> = tx.query_row("SELECT d.restore_status, 'T-' || c.number, s.status FROM duplicate_tickets d JOIN tickets c ON c.id = d.canonical_id JOIN tickets s ON s.id = d.source_id WHERE d.source_id = ?1", [&id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional()?;
        if let Some((restore, canonical, status)) = existing {
            tx.execute("DELETE FROM duplicate_tickets WHERE source_id = ?1", [&id])?;
            history::record(&tx, &id, "relationship:duplicate", &canonical, "", agent)?;
            if let Some(restore) = restore.filter(|r| r != &status) {
                tx.execute(
                    "UPDATE tickets SET status = ?1 WHERE id = ?2",
                    params![restore, id],
                )?;
                history::record(&tx, &id, "status", &status, &restore, agent)?;
            }
        }
        tx.commit()?;
        self.show_ticket(source)
    }
}

impl Workspace {
    pub fn preview_duplicate_dependencies(
        &self,
        source: &str,
        canonical: &str,
    ) -> Result<DuplicateDependencyPreview, Error> {
        self.preview_dependencies(source, canonical, true)
    }

    /// Previews moving `source`'s dependencies to `canonical` without canceling `source`,
    /// as a separate dependency review does.
    pub fn preview_dependency_move(
        &self,
        source: &str,
        canonical: &str,
    ) -> Result<DuplicateDependencyPreview, Error> {
        self.preview_dependencies(source, canonical, false)
    }

    fn preview_dependencies(
        &self,
        source: &str,
        canonical: &str,
        source_canceled: bool,
    ) -> Result<DuplicateDependencyPreview, Error> {
        let (destination, edges) = self.dependency_edges(source, canonical, source_canceled)?;
        let replacement_issues = edges
            .iter()
            .map(|edge| self.replacement_issue(edge))
            .collect::<Result<_, _>>()?;
        Ok(DuplicateDependencyPreview {
            canonical: destination,
            edges,
            replacement_issues,
        })
    }

    /// The canonical a review would move edges to, and the source's edges with
    /// where each would go. This is the part a review must still match when it
    /// is applied; it does not judge the replacements.
    fn dependency_edges(
        &self,
        source: &str,
        canonical: &str,
        source_canceled: bool,
    ) -> Result<(String, Vec<DependencyEdge>), Error> {
        let source_id = relationships::id(&self.connection, source)?;
        let canonical_id = relationships::id(&self.connection, canonical)?;
        let source: String = self.connection.query_row(
            "SELECT 'T-' || number FROM tickets WHERE id=?1",
            [&source_id],
            |r| r.get(0),
        )?;
        let destination: String = self.connection.query_row("SELECT 'T-' || t.number FROM tickets t WHERE t.id = COALESCE((SELECT canonical_id FROM duplicate_tickets WHERE source_id = ?1), ?1)", [&canonical_id], |r| r.get(0))?;
        let mut stmt = self.connection.prepare("SELECT 'T-' || b.number, 'T-' || d.number FROM dependencies e JOIN tickets b ON b.id=e.blocker_id JOIN tickets d ON d.id=e.dependent_id WHERE e.blocker_id=?1 OR e.dependent_id=?1 ORDER BY b.number,d.number LIMIT 1001")?;
        let pairs: Vec<(String, String)> = stmt
            .query_map([&source_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        drop(stmt);
        let view = ReadinessView {
            source_id: &source_id,
            source_canceled,
        };
        let mut edges = Vec::with_capacity(pairs.len());
        for (blocker, dependent) in pairs {
            let replacement_blocker = if blocker == source {
                destination.clone()
            } else {
                blocker.clone()
            };
            let replacement_dependent = if dependent == source {
                destination.clone()
            } else {
                dependent.clone()
            };
            let blocker_id = relationships::id(&self.connection, &blocker)?;
            let dependent_id = relationships::id(&self.connection, &dependent)?;
            let new_blocker_id = relationships::id(&self.connection, &replacement_blocker)?;
            let new_dependent_id = relationships::id(&self.connection, &replacement_dependent)?;
            let current = ReadinessView {
                source_id: &source_id,
                source_canceled: false,
            };
            // Replace moves the edge; when only its blocker changes the waiting ticket
            // loses the old blocker, and when only its dependent changes the new
            // dependent gains this blocker on top of its own.
            let dropped = (new_dependent_id == dependent_id).then_some(blocker_id.as_str());
            edges.push(DependencyEdge {
                dependent_status: self.status_of(&dependent_id)?,
                dependent_ready: self.ready_after(&dependent_id, None, None, &current)?,
                ready_if_replaced: self.ready_after(
                    &new_dependent_id,
                    dropped,
                    Some(&new_blocker_id),
                    &view,
                )?,
                ready_if_removed: self.ready_after(
                    &dependent_id,
                    Some(&blocker_id),
                    None,
                    &view,
                )?,
                ready_if_kept: self.ready_after(&dependent_id, None, None, &view)?,
                replacement_blocker,
                replacement_dependent,
                blocker,
                dependent,
            });
        }
        if edges.len() > 1000 {
            return Err(Error::InvalidBatch(
                "dependency review exceeds 1000 edges".into(),
            ));
        }
        Ok((destination, edges))
    }

    fn status_of(&self, id: &str) -> Result<Status, Error> {
        let status: String =
            self.connection
                .query_row("SELECT status FROM tickets WHERE id = ?1", [id], |r| {
                    r.get(0)
                })?;
        Ok(status.parse()?)
    }

    /// Whether `ticket` is Ready (Todo, every blocker satisfying a dependency) with the
    /// `dropped` blocker removed and the `added` one present. The duplicate marked by
    /// the review counts as Canceled when `view` says it will be.
    fn ready_after(
        &self,
        ticket: &str,
        dropped: Option<&str>,
        added: Option<&str>,
        view: &ReadinessView,
    ) -> Result<bool, Error> {
        let status_after = |id: &str| -> Result<Status, Error> {
            if view.source_canceled && id == view.source_id {
                Ok(Status::Canceled)
            } else {
                self.status_of(id)
            }
        };
        if status_after(ticket)? != Status::Todo {
            return Ok(false);
        }
        let mut stmt = self
            .connection
            .prepare("SELECT blocker_id FROM dependencies WHERE dependent_id = ?1")?;
        let blockers = stmt
            .query_map([ticket], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        for blocker in blockers
            .iter()
            .map(String::as_str)
            .filter(|b| Some(*b) != dropped)
            .chain(added)
        {
            if !status_after(blocker)?.satisfies_dependency() {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// Judges the replacement against the graph without the edge it would replace.
    fn replacement_issue(&self, edge: &DependencyEdge) -> Result<Option<ReplacementIssue>, Error> {
        if edge.replacement_blocker == edge.replacement_dependent {
            return Ok(Some(ReplacementIssue::SelfBlock));
        }
        let blocker = relationships::id(&self.connection, &edge.replacement_blocker)?;
        let dependent = relationships::id(&self.connection, &edge.replacement_dependent)?;
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
        self.connection
            .execute_batch("SAVEPOINT duplicate_review")?;
        let result = (|| {
            crate::transaction_write_lock(&self.connection)?;
            self.apply_dependency_review(
                source,
                canonical,
                expected_canonical,
                &decisions,
                true,
                agent,
            )?;
            self.mark_duplicate_internal(source, canonical, agent, true)
        })();
        match result {
            Ok(ticket) => {
                self.connection.execute_batch("RELEASE duplicate_review")?;
                Ok(ticket)
            }
            Err(error) => {
                self.connection
                    .execute_batch("ROLLBACK TO duplicate_review; RELEASE duplicate_review")?;
                Err(error)
            }
        }
    }
    pub fn edit_dependencies_reviewed(
        &mut self,
        source: &str,
        canonical: &str,
        expected_canonical: &str,
        decisions: Vec<DependencyDecision>,
        agent: Option<&str>,
    ) -> Result<Ticket, Error> {
        self.connection
            .execute_batch("SAVEPOINT dependency_review")?;
        let result = (|| {
            crate::transaction_write_lock(&self.connection)?;
            self.apply_dependency_review(
                source,
                canonical,
                expected_canonical,
                &decisions,
                false,
                agent,
            )?;
            self.show_ticket(source)
        })();
        match result {
            Ok(ticket) => {
                self.connection.execute_batch("RELEASE dependency_review")?;
                Ok(ticket)
            }
            Err(error) => {
                self.connection
                    .execute_batch("ROLLBACK TO dependency_review; RELEASE dependency_review")?;
                Err(error)
            }
        }
    }

    fn apply_dependency_review(
        &mut self,
        source: &str,
        canonical: &str,
        expected_canonical: &str,
        decisions: &[DependencyDecision],
        source_canceled: bool,
        agent: Option<&str>,
    ) -> Result<(), Error> {
        let (destination, current_edges) =
            self.dependency_edges(source, canonical, source_canceled)?;
        let edges: Vec<_> = decisions.iter().map(|d| d.edge.clone()).collect();
        if edges != current_edges || expected_canonical != destination {
            return Err(Error::DependencyReviewChanged);
        }
        // A replacement that became a cycle or a duplicate since the review was
        // shown, through an unrelated change, is as stale as a changed edge.
        for decision in decisions {
            if decision.choice == DependencyChoice::Replace
                && self.replacement_issue(&decision.edge)?.is_some()
            {
                return Err(Error::DependencyReviewChanged);
            }
        }
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
