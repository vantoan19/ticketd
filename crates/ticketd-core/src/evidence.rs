use crate::{Error, Workspace, ensure_editable, history, relationships, transaction_write_lock};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceKind {
    PullRequest,
    Commit,
    Branch,
    Worktree,
    Verification,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvidenceInput {
    pub kind: EvidenceKind,
    pub name: String,
    pub value: String,
    pub editing_agent: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Evidence {
    pub id: String,
    pub kind: EvidenceKind,
    pub name: String,
    pub value: String,
    pub created_at: String,
    pub updated_at: String,
    pub editing_agent: Option<String>,
}
fn validate(input: &EvidenceInput) -> Result<(), Error> {
    if input.name.trim().is_empty() || input.value.trim().is_empty() {
        return Err(Error::InvalidEvidence(
            "name and value must not be empty".into(),
        ));
    }
    if input.kind == EvidenceKind::PullRequest {
        let authority = input
            .value
            .strip_prefix("https://")
            .or_else(|| input.value.strip_prefix("http://"));
        if authority.is_none_or(|value| {
            value
                .split(['/', '?', '#'])
                .next()
                .is_none_or(str::is_empty)
        }) || input.value.chars().any(char::is_whitespace)
        {
            return Err(Error::InvalidEvidence(
                "Pull request link must start with http:// or https:// and include a host".into(),
            ));
        }
    }
    Ok(())
}
fn kind_string(kind: EvidenceKind) -> &'static str {
    match kind {
        EvidenceKind::PullRequest => "pull_request",
        EvidenceKind::Commit => "commit",
        EvidenceKind::Branch => "branch",
        EvidenceKind::Worktree => "worktree",
        EvidenceKind::Verification => "verification",
    }
}
fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Evidence> {
    let kind: String = row.get(1)?;
    let kind = match kind.as_str() {
        "pull_request" => EvidenceKind::PullRequest,
        "commit" => EvidenceKind::Commit,
        "branch" => EvidenceKind::Branch,
        "worktree" => EvidenceKind::Worktree,
        "verification" => EvidenceKind::Verification,
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    Ok(Evidence {
        id: row.get(0)?,
        kind,
        name: row.get(2)?,
        value: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        editing_agent: row.get(6)?,
    })
}
fn get(conn: &Connection, ticket: &str, id: &str) -> Result<Evidence, Error> {
    conn.query_row("SELECT id, kind, name, value, created_at, updated_at, editing_agent FROM evidence WHERE ticket_id=?1 AND id=?2", params![ticket,id], row).optional()?.ok_or_else(|| Error::EvidenceNotFound(id.into()))
}
impl Workspace {
    pub fn add_evidence(
        &mut self,
        reference: &str,
        input: EvidenceInput,
    ) -> Result<Evidence, Error> {
        validate(&input)?;
        let tx = self.connection.savepoint()?;
        transaction_write_lock(&tx)?;
        let ticket = relationships::id(&tx, reference)?;
        ensure_editable(&tx, &ticket)?;
        let id = Uuid::new_v4().to_string();
        tx.execute("INSERT INTO evidence (id,ticket_id,kind,name,value,editing_agent) VALUES (?1,?2,?3,?4,?5,?6)", params![id,ticket,kind_string(input.kind),input.name,input.value,input.editing_agent])?;
        history::record(
            &tx,
            &ticket,
            "evidence",
            "",
            &input.name,
            input.editing_agent.as_deref(),
        )?;
        let result = get(&tx, &ticket, &id)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn edit_evidence(
        &mut self,
        reference: &str,
        id: &str,
        input: EvidenceInput,
    ) -> Result<Evidence, Error> {
        validate(&input)?;
        let tx = self.connection.savepoint()?;
        transaction_write_lock(&tx)?;
        let ticket = relationships::id(&tx, reference)?;
        ensure_editable(&tx, &ticket)?;
        let old = get(&tx, &ticket, id)?;
        tx.execute("UPDATE evidence SET kind=?1,name=?2,value=?3,editing_agent=?4,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ticket_id=?5 AND id=?6", params![kind_string(input.kind),input.name,input.value,input.editing_agent,ticket,id])?;
        history::record(
            &tx,
            &ticket,
            "evidence",
            &old.name,
            &input.name,
            input.editing_agent.as_deref(),
        )?;
        let result = get(&tx, &ticket, id)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn delete_evidence(&mut self, reference: &str, id: &str) -> Result<(), Error> {
        let tx = self.connection.savepoint()?;
        transaction_write_lock(&tx)?;
        let ticket = relationships::id(&tx, reference)?;
        ensure_editable(&tx, &ticket)?;
        let old = get(&tx, &ticket, id)?;
        tx.execute(
            "DELETE FROM evidence WHERE ticket_id=?1 AND id=?2",
            params![ticket, id],
        )?;
        history::record(&tx, &ticket, "evidence", &old.name, "", None)?;
        tx.commit()?;
        Ok(())
    }
    pub fn evidence(
        &self,
        reference: &str,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<Evidence>, Error> {
        let ticket = relationships::id(&self.connection, reference)?;
        let mut stmt = self.connection.prepare("SELECT id,kind,name,value,created_at,updated_at,editing_agent FROM evidence WHERE ticket_id=?1 ORDER BY number LIMIT ?2 OFFSET ?3")?;
        Ok(stmt
            .query_map(params![ticket, limit.clamp(1, 100), offset], row)?
            .collect::<Result<Vec<_>, _>>()?)
    }
}
