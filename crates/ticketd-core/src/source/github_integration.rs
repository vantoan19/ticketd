//! Device-local issue-import rules and account choices for the built-in integration.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{
    ConfigValues, ConfiguredSource, ConnectionInfo, DiscoveryPreview, Engine, FieldIssue,
    SavedSource, SourceError, SourceFailure, SourceRepositoryProject, github, stale_source,
};
use crate::{
    Error, Workspace, project_remote::normalize_project_remote, projects, read_scope, write_scope,
};

pub const GITHUB_INTEGRATION: &str = "github";
const PUBLIC_HOST: &str = "github.com";
pub(super) const REPOSITORY_JOB_PREFIX: &str = "github:";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubRepositoryRule {
    pub repository: String,
    pub assignee: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GithubRepository {
    #[serde(flatten)]
    pub rule: GithubRepositoryRule,
    pub project: Option<SourceRepositoryProject>,
    pub project_login: Option<String>,
    pub tracked_tickets: u32,
    pub last_refreshed_at: Option<String>,
    pub error: Option<SourceFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GithubMigrationNotice {
    pub repository: String,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GithubReadiness {
    Connected,
    NotInstalled,
    NotSignedIn,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GithubHost {
    pub host: String,
    pub state: GithubReadiness,
    pub login: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GithubIntegration {
    pub id: &'static str,
    pub hosts: Vec<GithubHost>,
    pub repositories: Vec<GithubRepository>,
    pub migration_notices: Vec<GithubMigrationNotice>,
}

pub(crate) fn migrate(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch(
        "CREATE TABLE github_repository_rules (
           repository TEXT PRIMARY KEY COLLATE NOCASE, host TEXT NOT NULL, assignee TEXT,
           labels TEXT NOT NULL, revision TEXT NOT NULL, saved_at TEXT NOT NULL
         );
         CREATE TABLE github_repository_status (
           repository TEXT PRIMARY KEY REFERENCES github_repository_rules(repository) ON DELETE CASCADE,
           last_attempt_at TEXT, last_refreshed_at TEXT, error_code TEXT, error_message TEXT,
           failing_since TEXT, retry_after TEXT, partial_message TEXT, last_checked_tickets INTEGER,
           read_partitions TEXT
         );
         CREATE TABLE github_project_logins (
           project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
           host TEXT NOT NULL COLLATE NOCASE, login TEXT NOT NULL,
           PRIMARY KEY (project_id, host)
         );
         CREATE TABLE github_legacy_accounts (
           connection_id TEXT PRIMARY KEY, host TEXT NOT NULL, login TEXT NOT NULL,
           account_key TEXT NOT NULL, saved_at TEXT NOT NULL
         );
         CREATE TABLE github_legacy_repository_rules (
           repository TEXT NOT NULL COLLATE NOCASE, connection_id TEXT NOT NULL REFERENCES github_legacy_accounts(connection_id) ON DELETE CASCADE,
           assignee TEXT, labels TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0,
           PRIMARY KEY (repository, connection_id)
         );
         CREATE TABLE github_legacy_status (
           connection_id TEXT PRIMARY KEY REFERENCES github_legacy_accounts(connection_id) ON DELETE CASCADE,
           last_attempt_at TEXT, last_refreshed_at TEXT, error_code TEXT, error_message TEXT,
           failing_since TEXT, retry_after TEXT, partial_message TEXT, last_checked_tickets INTEGER,
           read_partitions TEXT
         );
         CREATE TABLE github_legacy_ticket_bindings (
           ticket_id TEXT PRIMARY KEY REFERENCES external_identities(ticket_id) ON UPDATE CASCADE ON DELETE CASCADE,
           connection_id TEXT NOT NULL REFERENCES github_legacy_accounts(connection_id) ON DELETE CASCADE
         );
         CREATE TABLE github_publication_context (
           attempt_id TEXT PRIMARY KEY REFERENCES publication_attempts(id) ON DELETE CASCADE,
           host TEXT NOT NULL, login TEXT, account_key TEXT, tracker_started_at TEXT
         );
         INSERT INTO github_legacy_accounts
           SELECT id, CASE WHEN site = '' THEN 'github.com' ELSE lower(site) END, account, account_key, saved_at
           FROM source_connections WHERE provider = 'github';
         INSERT INTO github_legacy_status SELECT s.* FROM source_connection_status s
           JOIN github_legacy_accounts a USING (connection_id);
         INSERT INTO github_legacy_ticket_bindings SELECT t.* FROM source_connection_tickets t
           JOIN github_legacy_accounts a USING (connection_id);
         INSERT INTO github_publication_context
           SELECT p.attempt_id, COALESCE(NULLIF(a.destination_host, ''), c.host), c.login, c.account_key, p.tracker_started_at
           FROM publication_connections p JOIN github_legacy_accounts c USING (connection_id)
           JOIN publication_attempts a ON a.id = p.attempt_id;",
    )?;
    let mut rows = connection.prepare(
        "SELECT a.connection_id, a.host, s.configuration FROM github_legacy_accounts a
         JOIN source_connections s ON s.id = a.connection_id ORDER BY a.connection_id",
    )?;
    let configurations = rows
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut repositories = BTreeMap::<String, Vec<(String, GithubRepositoryRule)>>::new();
    for (id, host, configuration) in configurations {
        let config: ConfigValues = serde_json::from_str(&configuration)?;
        let assignee = config
            .get("assignee")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let labels = strings(config.get("labels"));
        for name in strings(config.get(super::REPOSITORIES)) {
            let repository = format!("{host}/{name}");
            let normalized = normalize_repository(&repository);
            let rule = GithubRepositoryRule {
                repository: normalized.unwrap_or(repository),
                assignee: assignee.clone(),
                labels: labels.clone(),
            };
            connection.execute(
                "INSERT OR IGNORE INTO github_legacy_repository_rules (repository, connection_id, assignee, labels) VALUES (?1,?2,?3,?4)",
                params![rule.repository, id, rule.assignee, serde_json::to_string(&rule.labels)?],
            )?;
            let candidates = repositories.entry(rule.repository.clone()).or_default();
            if !candidates.iter().any(|(candidate, _)| candidate == &id) {
                candidates.push((id.clone(), rule));
            }
        }
    }
    for (repository, candidates) in repositories {
        let Some((id, rule)) = candidates.first() else {
            continue;
        };
        if normalize_project_remote(&repository).is_none()
            || candidates
                .iter()
                .skip(1)
                .any(|(_, candidate)| candidate != rule)
        {
            continue;
        }
        let (host, name) = repository_parts(&repository)?;
        let revision = format!("legacy:{id}");
        connection.execute(
            "INSERT INTO github_repository_rules
             SELECT ?1, ?2, ?3, ?4, ?5, saved_at FROM github_legacy_accounts WHERE connection_id = ?6",
            params![repository, host, rule.assignee, serde_json::to_string(&rule.labels)?, revision, id],
        )?;
        if candidates.len() != 1 {
            continue;
        }
        let partition = github::partition_name(Some(host), name);
        let config = rule_configuration(rule, None)?;
        let derived = github::legacy_derived_configuration(GITHUB_INTEGRATION, host, &config)
            .unwrap_or_default();
        let scoped = super::freshness::scoped_partition(&partition, &derived.discovery_scope);
        connection.execute(
            "INSERT INTO github_repository_status
             SELECT ?2, last_attempt_at,last_refreshed_at,error_code,error_message,failing_since,retry_after,
                    partial_message,last_checked_tickets,
                    CASE WHEN s.read_partitions IS NULL THEN NULL
                         WHEN EXISTS(SELECT 1 FROM json_each(s.read_partitions) WHERE value IN (?3,?4))
                         THEN json_array(?4) ELSE '[]' END
             FROM github_legacy_status s WHERE connection_id = ?1",
            params![id, repository, partition, scoped],
        )?;
    }
    // The migration ladder disables foreign keys until every step has run.
    connection.execute_batch(
        "DELETE FROM publication_connections WHERE connection_id IN (SELECT connection_id FROM github_legacy_accounts);
         DELETE FROM source_connection_tickets WHERE connection_id IN (SELECT connection_id FROM github_legacy_accounts);
         DELETE FROM source_connection_status WHERE connection_id IN (SELECT connection_id FROM github_legacy_accounts);
         DELETE FROM source_secret_references WHERE connection_id IN (SELECT connection_id FROM github_legacy_accounts);
         DELETE FROM source_connections WHERE provider = 'github';",
    )?;
    Ok(())
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn repository_parts(repository: &str) -> Result<(&str, &str), Error> {
    repository
        .split_once('/')
        .ok_or(Error::InvalidProjectRemote)
}

pub(super) fn normalized_host(host: &str) -> Result<String, Error> {
    let candidate = normalize_project_remote(&format!("{host}/owner/repo"))
        .ok_or(Error::InvalidProjectRemote)?;
    let (host, rest) = repository_parts(&candidate)?;
    if rest != "owner/repo" {
        return Err(Error::InvalidProjectRemote);
    }
    Ok(host.into())
}

fn normalize_repository(repository: &str) -> Option<String> {
    // The source API identity and repository rules ignore case on all hosts.
    normalize_project_remote(repository).map(|value| value.to_ascii_lowercase())
}

pub async fn sign_in_github(
    host: &str,
    canceled: tokio::sync::watch::Receiver<bool>,
    code: impl FnMut(String) -> Result<(), SourceError>,
    browser: impl FnMut(String) -> Result<(), SourceError>,
) -> Result<(), Error> {
    let host = normalized_host(host)?;
    Ok(github::sign_in(&host, canceled, code, browser).await?)
}

fn normalized_rule(mut rule: GithubRepositoryRule) -> Result<GithubRepositoryRule, Error> {
    rule.repository = normalize_repository(&rule.repository).ok_or(Error::InvalidProjectRemote)?;
    Ok(rule)
}

fn project_login(
    connection: &Connection,
    project: Option<&str>,
    host: &str,
) -> Result<Option<String>, Error> {
    let Some(project) = project else {
        return Ok(None);
    };
    Ok(connection
        .query_row(
            "SELECT login FROM github_project_logins WHERE project_id = ?1 AND host = ?2",
            params![project, host],
            |row| row.get(0),
        )
        .optional()?)
}

fn project_route(
    connection: &Connection,
    repository: &str,
) -> Result<Option<SourceRepositoryProject>, Error> {
    Ok(projects::find_by_remote(connection, repository)?
        .filter(|project| !project.archived)
        .map(|project| SourceRepositoryProject {
            id: project.id,
            name: project.name,
        }))
}

fn rule_configuration(
    rule: &GithubRepositoryRule,
    login: Option<&str>,
) -> Result<ConfigValues, Error> {
    let (host, name) = repository_parts(&rule.repository)?;
    let mut config = host_configuration(host, login);
    config.insert(super::REPOSITORIES.into(), json!([name]));
    if let Some(assignee) = &rule.assignee {
        config.insert("assignee".into(), json!(assignee));
    }
    if !rule.labels.is_empty() {
        config.insert("labels".into(), json!(rule.labels));
    }
    Ok(config)
}

pub(super) fn host_configuration(host: &str, login: Option<&str>) -> ConfigValues {
    let mut config = [(github::SITE_CONFIG.into(), json!(host))]
        .into_iter()
        .collect::<ConfigValues>();
    if let Some(login) = login {
        config.insert("account".into(), json!(login));
    }
    config
}

pub(super) fn checked_host(
    engine: &Engine,
    host: &str,
    login: Option<&str>,
) -> Result<(Engine, ConnectionInfo), SourceError> {
    let config = host_configuration(host, login);
    let scoped = engine
        .for_connection(GITHUB_INTEGRATION, GITHUB_INTEGRATION, &config)
        .with_workflow_credentials(GITHUB_INTEGRATION, &config)?;
    let account = scoped.check(GITHUB_INTEGRATION, &config)?.connection;
    let actual_host = if account.site.is_empty() {
        PUBLIC_HOST
    } else {
        &account.site
    };
    if actual_host != host
        || login.is_some_and(|login| !login.eq_ignore_ascii_case(&account.account))
    {
        return Err(SourceError::Unauthenticated(format!(
            "Verify the selected GitHub login on {host} and try again."
        )));
    }
    Ok((scoped, account))
}

fn host_readiness(engine: &Engine, host: &str) -> GithubHost {
    let (state, login, message) = match checked_host(engine, host, None) {
        Ok((_, account)) => (GithubReadiness::Connected, Some(account.account), None),
        Err(error) => {
            let state = match &error {
                SourceError::Unavailable(message) if message == github::GH_NOT_INSTALLED => {
                    GithubReadiness::NotInstalled
                }
                SourceError::Unauthenticated(_) => GithubReadiness::NotSignedIn,
                _ => GithubReadiness::Unavailable,
            };
            (state, None, Some(error.to_string()))
        }
    };
    GithubHost {
        host: host.into(),
        state,
        login,
        message,
    }
}

#[derive(Debug, Clone)]
pub struct VerifiedGithubLogin {
    pub login: String,
    pub account_id: Option<String>,
}

impl From<ConnectionInfo> for VerifiedGithubLogin {
    fn from(info: ConnectionInfo) -> Self {
        Self {
            login: info.account,
            account_id: info.account_id,
        }
    }
}

#[derive(Clone)]
struct LegacyRule {
    repository: String,
    host: String,
    login: String,
    account_key: String,
    assignee: Option<String>,
    labels: String,
}

impl LegacyRule {
    fn matches(&self, login: &VerifiedGithubLogin) -> bool {
        match github::account_database_id(&self.account_key) {
            Some(id) => {
                login
                    .account_id
                    .as_deref()
                    .and_then(github::account_database_id)
                    == Some(id)
            }
            None => self.login.eq_ignore_ascii_case(&login.login),
        }
    }

    fn same_account(&self, other: &Self) -> bool {
        match (
            github::account_database_id(&self.account_key),
            github::account_database_id(&other.account_key),
        ) {
            (Some(left), Some(right)) => left == right,
            (None, None) => self.login.eq_ignore_ascii_case(&other.login),
            _ => false,
        }
    }
}

fn pending_rules(connection: &Connection) -> Result<Vec<LegacyRule>, Error> {
    let mut statement = connection.prepare(
        "SELECT r.repository,a.host,a.login,a.account_key,r.assignee,r.labels
         FROM github_legacy_repository_rules r JOIN github_legacy_accounts a USING(connection_id)
         WHERE r.resolved = 0 ORDER BY r.repository, a.connection_id",
    )?;
    Ok(statement
        .query_map([], |row| {
            Ok(LegacyRule {
                repository: row.get(0)?,
                host: row.get(1)?,
                login: row.get(2)?,
                account_key: row.get(3)?,
                assignee: row.get(4)?,
                labels: row.get(5)?,
            })
        })?
        .collect::<Result<_, _>>()?)
}

impl Workspace {
    pub fn github_repositories(&self) -> Result<Vec<GithubRepository>, Error> {
        self.read(|workspace| repositories(&workspace.connection))
    }

    pub fn github_integration(&mut self, engine: &Engine) -> Result<GithubIntegration, Error> {
        let mut statement = self.connection.prepare(
            "SELECT host FROM github_repository_rules UNION SELECT host FROM github_project_logins
             UNION SELECT host FROM github_legacy_accounts UNION SELECT 'github.com' ORDER BY 1",
        )?;
        let names = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        let hosts: Vec<_> = names
            .iter()
            .map(|host| host_readiness(engine, host))
            .collect();
        let migration_notices = self.reconcile_github_migration(|host, login| {
            checked_host(engine, host, login)
                .ok()
                .map(|(_, account)| account.into())
        })?;
        Ok(GithubIntegration {
            id: GITHUB_INTEGRATION,
            hosts,
            repositories: self.github_repositories()?,
            migration_notices,
        })
    }

    pub fn github_host_readiness(&self, engine: &Engine, host: &str) -> Result<GithubHost, Error> {
        Ok(host_readiness(engine, &normalized_host(host)?))
    }

    /// Resolve device-local migration candidates against a verified snapshot. The
    /// account lookup runs outside the write transaction, including on retries.
    pub fn reconcile_github_migration(
        &mut self,
        verify: impl Fn(&str, Option<&str>) -> Option<VerifiedGithubLogin>,
    ) -> Result<Vec<GithubMigrationNotice>, Error> {
        let pending = pending_rules(&self.connection)?;
        if pending.is_empty() {
            return Ok(Vec::new());
        }
        let hosts: BTreeSet<_> = pending.iter().map(|rule| rule.host.as_str()).collect();
        let active: BTreeMap<_, _> = hosts
            .into_iter()
            .map(|host| (host.to_owned(), verify(host, None)))
            .collect();
        let mut named = BTreeMap::new();
        for rule in &pending {
            if github::account_database_id(&rule.account_key).is_some()
                && active
                    .get(&rule.host)
                    .and_then(Option::as_ref)
                    .is_some_and(|active| !rule.matches(active))
            {
                named
                    .entry((rule.host.clone(), rule.login.to_ascii_lowercase()))
                    .or_insert_with(|| verify(&rule.host, Some(&rule.login)));
            }
        }
        write_scope::run(&self.connection, |transaction| {
            let pending = pending_rules(transaction)?;
            let mut notices = Vec::new();
            for group in pending.chunk_by(|left, right| left.repository == right.repository) {
                let Some(rule) = group.first() else { continue };
                let repository = &rule.repository;
                let notice = if normalize_project_remote(repository).is_none() {
                    Some("The previous GitHub repository has an invalid name. Add its corrected name to resume import.".into())
                } else if group
                    .iter()
                    .any(|other| rule.assignee != other.assignee || rule.labels != other.labels)
                {
                    Some("Previous GitHub connections saved different filters. Review and save the filters to resume import.".into())
                } else if !super::ValueFormat::Handle.is_valid(&rule.login) {
                    Some("The previous GitHub login could not be identified. Review the Project login and save the filters to resume import.".into())
                } else if group.iter().any(|other| !rule.same_account(other)) {
                    Some("Previous GitHub connections used different logins for this repository. Review the Project login and save the filters to resume import.".into())
                } else if let Some(Some(login)) = active.get(&rule.host) {
                    if rule.matches(login) {
                        None
                    } else if let Some(project) = project_route(transaction, repository)? {
                        let named = named
                            .get(&(rule.host.clone(), rule.login.to_ascii_lowercase()))
                            .and_then(Option::as_ref);
                        if github::account_database_id(&rule.account_key).is_some()
                            && !named.is_some_and(|named| rule.matches(named))
                        {
                            notices.push(GithubMigrationNotice {
                                repository: repository.clone(),
                                message: format!("The previous GitHub login {} could not be verified as the account originally used. Review the Project login and filters before resuming import.", rule.login),
                            });
                            continue;
                        }
                        let pin =
                            named.map_or(rule.login.as_str(), |account| account.login.as_str());
                        let existing = project_login(transaction, Some(&project.id), &rule.host)?;
                        if existing.is_some_and(|login| !login.eq_ignore_ascii_case(pin)) {
                            Some(format!(
                                "The previous GitHub login {} differs from the Project's selected login. Review the Project login and save the filters to resume import.",
                                rule.login
                            ))
                        } else {
                            transaction.execute(
                                "INSERT INTO github_project_logins VALUES (?1,?2,?3) ON CONFLICT DO NOTHING",
                                params![project.id, rule.host, pin],
                            )?;
                            None
                        }
                    } else {
                        Some(format!(
                            "The previous GitHub login {} differs from the active login and no active Project claims this repository.",
                            rule.login
                        ))
                    }
                } else {
                    Some(format!(
                        "The active GitHub login on {} could not be verified. The previous login is {}.",
                        rule.host, rule.login
                    ))
                };
                if let Some(message) = notice {
                    notices.push(GithubMigrationNotice {
                        repository: repository.clone(),
                        message,
                    });
                } else {
                    transaction.execute("UPDATE github_legacy_repository_rules SET resolved = 1 WHERE repository = ?1", [repository])?;
                }
            }
            Ok(notices)
        })
    }

    /// The explicit Project choice, scoped to the repository host. A missing
    /// choice uses the GitHub CLI's active login on that host.
    pub fn github_project_login(
        &self,
        project: Option<&str>,
        host: &str,
    ) -> Result<Option<String>, Error> {
        project_login(&self.connection, project, &normalized_host(host)?)
    }

    pub fn set_github_project_login(
        &mut self,
        engine: &Engine,
        project: &str,
        host: &str,
        login: Option<&str>,
    ) -> Result<(), Error> {
        let host = normalized_host(host)?;
        let verified = login
            .map(|login| {
                if !super::ValueFormat::Handle.is_valid(login) {
                    return Err(SourceError::InvalidConfiguration(vec![
                        FieldIssue::for_field("login", "enter a GitHub login name"),
                    ]));
                }
                checked_host(engine, &host, Some(login)).map(|(_, account)| account.account)
            })
            .transpose()?;
        write_scope::run(&self.connection, |transaction| {
            projects::ensure_active(transaction, project)?;
            if let Some(login) = &verified {
                transaction.execute(
                    "INSERT INTO github_project_logins VALUES (?1,?2,?3)
                     ON CONFLICT(project_id,host) DO UPDATE SET login = excluded.login",
                    params![project, host, login],
                )?;
            } else {
                transaction.execute(
                    "DELETE FROM github_project_logins WHERE project_id = ?1 AND host = ?2",
                    params![project, host],
                )?;
            }
            Ok(())
        })
    }

    pub fn preview_github_repository(
        &self,
        engine: &Engine,
        rule: GithubRepositoryRule,
    ) -> Result<DiscoveryPreview, Error> {
        self.check_github_repository(engine, &normalized_rule(rule)?)
            .map(|(preview, _)| preview)
    }

    pub fn save_github_repository(
        &mut self,
        engine: &Engine,
        rule: GithubRepositoryRule,
    ) -> Result<GithubRepository, Error> {
        let rule = normalized_rule(rule)?;
        let (_, route) = self.check_github_repository(engine, &rule)?;
        write_scope::run(&self.connection, |transaction| {
            if repository_route(transaction, &rule.repository)? != route {
                return Err(stale_source());
            }
            save_rule(transaction, &rule)?;
            repositories(transaction)?
                .into_iter()
                .find(|entry| entry.rule.repository == rule.repository)
                .ok_or(Error::SourceRepositoryNotListed(rule.repository.clone()))
        })
    }

    fn check_github_repository(
        &self,
        engine: &Engine,
        rule: &GithubRepositoryRule,
    ) -> Result<(DiscoveryPreview, RepositoryRoute), Error> {
        let route = read_scope::run(&self.connection, |connection| {
            repository_route(connection, &rule.repository)
        })?;
        let (host, _) = repository_parts(&rule.repository)?;
        let config = rule_configuration(rule, route.1.as_deref())?;
        let scoped = engine
            .for_connection(GITHUB_INTEGRATION, GITHUB_INTEGRATION, &config)
            .with_workflow_credentials(GITHUB_INTEGRATION, &config)?;
        let validated = scoped.validate_configuration(GITHUB_INTEGRATION, &config)?;
        let (preview, _, _) =
            self.preview_source_with_config(&scoped, GITHUB_INTEGRATION, &validated)?;
        if scoped.issue_site(GITHUB_INTEGRATION)? != Some(host) {
            return Err(Error::InvalidProjectRemote);
        }
        Ok((preview, route))
    }

    pub fn remove_github_repository(&mut self, repository: &str) -> Result<(), Error> {
        let repository = normalize_repository(repository).ok_or(Error::InvalidProjectRemote)?;
        write_scope::run(&self.connection, |transaction| {
            if transaction.execute(
                "DELETE FROM github_repository_rules WHERE repository = ?1",
                [&repository],
            )? == 0
            {
                return Err(Error::SourceRepositoryNotListed(repository.clone()));
            }
            transaction.execute(
                "UPDATE github_legacy_repository_rules SET resolved = 1 WHERE repository = ?1",
                [&repository],
            )?;
            let (host, name) = repository_parts(&repository)?;
            let partition = github::partition_name(Some(host), name);
            transaction.execute(
                "INSERT INTO source_connection_removals (ticket_id, removed_at)
                 SELECT i.ticket_id, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM external_identities i
                 JOIN external_ownership o USING(ticket_id)
                 WHERE i.provider = 'github' AND (i.repository = ?1 COLLATE NOCASE OR i.partition = ?2 COLLATE NOCASE)
                   AND o.authority = 'external' ON CONFLICT DO NOTHING",
                params![repository, partition],
            )?;
            Ok(())
        })
    }
}

type RepositoryRoute = (Option<SourceRepositoryProject>, Option<String>);

fn repository_route(connection: &Connection, repository: &str) -> Result<RepositoryRoute, Error> {
    let (host, _) = repository_parts(repository)?;
    let project = project_route(connection, repository)?;
    let login = project_login(
        connection,
        project.as_ref().map(|project| project.id.as_str()),
        host,
    )?;
    Ok((project, login))
}

pub(super) fn save_rule(connection: &Connection, rule: &GithubRepositoryRule) -> Result<(), Error> {
    let (host, name) = repository_parts(&rule.repository)?;
    let labels = serde_json::to_string(&rule.labels)?;
    let updated = connection.execute(
        "INSERT INTO github_repository_rules VALUES (?1,?2,?3,?4,?5,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(repository) DO UPDATE SET assignee = excluded.assignee, labels = excluded.labels, revision = excluded.revision
         WHERE github_repository_rules.assignee IS NOT excluded.assignee OR github_repository_rules.labels != excluded.labels",
        params![rule.repository, host, rule.assignee, labels, uuid::Uuid::new_v4().to_string()],
    )?;
    if updated != 0 {
        connection.execute(
            "UPDATE github_repository_status SET read_partitions = '[]' WHERE repository = ?1",
            [&rule.repository],
        )?;
        let partition = github::partition_name(Some(host), name);
        connection.execute(
            "DELETE FROM source_connection_removals WHERE ticket_id IN
             (SELECT ticket_id FROM external_identities WHERE provider = 'github' AND partition = ?1 COLLATE NOCASE)",
            [&partition],
        )?;
        connection.execute(
            "UPDATE source_sync SET discovery_matches = NULL WHERE ticket_id IN
             (SELECT ticket_id FROM external_identities WHERE provider = 'github' AND partition = ?1 COLLATE NOCASE)",
            [partition],
        )?;
    }
    connection.execute(
        "UPDATE github_legacy_repository_rules SET resolved = 1 WHERE repository = ?1",
        [&rule.repository],
    )?;
    Ok(())
}

fn repositories(connection: &Connection) -> Result<Vec<GithubRepository>, Error> {
    let mut statement = connection.prepare(
        "SELECT r.repository, r.assignee, r.labels, s.last_refreshed_at,s.error_code,s.error_message,
                (SELECT count(*) FROM external_identities i JOIN external_ownership o USING(ticket_id)
                 JOIN tickets t ON t.id = i.ticket_id
                 WHERE i.provider = 'github' AND i.repository = r.repository COLLATE NOCASE
                   AND o.authority = 'external' AND t.trashed = 0)
         FROM github_repository_rules r LEFT JOIN github_repository_status s USING(repository)
         ORDER BY r.repository",
    )?;
    let mut records = statement.query([])?;
    let mut repositories = Vec::new();
    while let Some(row) = records.next()? {
        let repository: String = row.get(0)?;
        let (project, project_login) = repository_route(connection, &repository)?;
        let error_code: Option<String> = row.get(4)?;
        let error_message: Option<String> = row.get(5)?;
        repositories.push(GithubRepository {
            rule: GithubRepositoryRule {
                repository,
                assignee: row.get(1)?,
                labels: serde_json::from_str(&row.get::<_, String>(2)?)?,
            },
            project,
            project_login,
            tracked_tickets: row.get(6)?,
            last_refreshed_at: row.get(3)?,
            error: error_code.map(|code| SourceFailure {
                code,
                message: error_message.unwrap_or_default(),
            }),
        });
    }
    Ok(repositories)
}

pub(super) fn repository_job(id: &str) -> Option<&str> {
    id.strip_prefix(REPOSITORY_JOB_PREFIX)
}

pub(super) fn job_id(repository: &str) -> String {
    format!("{REPOSITORY_JOB_PREFIX}{repository}")
}

pub(super) fn refresh_jobs(connection: &Connection) -> Result<Vec<ConfiguredSource>, Error> {
    let mut statement = connection.prepare(
        "SELECT r.repository, r.assignee, r.labels, r.revision, r.saved_at
         FROM github_repository_rules r WHERE NOT EXISTS (
             SELECT 1 FROM github_legacy_repository_rules l WHERE l.repository = r.repository AND l.resolved = 0)
         ORDER BY r.repository",
    )?;
    let mut rows = statement.query([])?;
    let mut jobs = Vec::new();
    while let Some(row) = rows.next()? {
        let repository: String = row.get(0)?;
        let rule = GithubRepositoryRule {
            repository,
            assignee: row.get(1)?,
            labels: serde_json::from_str(&row.get::<_, String>(2)?)?,
        };
        let (_, login) = repository_route(connection, &rule.repository)?;
        let (host, _) = repository_parts(&rule.repository)?;
        let config = rule_configuration(&rule, login.as_deref())?;
        let saved_revision: String = row.get(3)?;
        let revision = serde_json::to_string(&(saved_revision, &login))?;
        jobs.push(ConfiguredSource {
            saved: SavedSource {
                id: job_id(&rule.repository),
                name: rule.repository.clone(),
                provider: GITHUB_INTEGRATION.into(),
                config: config.clone(),
                account: login.unwrap_or_default(),
                saved_at: row.get(4)?,
                secret_fields: Vec::new(),
                session_secret_fields: Vec::new(),
            },
            derived: github::legacy_derived_configuration(GITHUB_INTEGRATION, host, &config)
                .unwrap_or_default(),
            revision,
            site: if host == PUBLIC_HOST {
                String::new()
            } else {
                host.into()
            },
            credentials: super::credentials::References::new(),
            permitted_env: Default::default(),
            account_key: String::new(),
        });
    }
    Ok(jobs)
}

impl Workspace {
    pub(super) fn reconcile_github_with_engine(&mut self, engine: &Engine) -> Result<(), Error> {
        self.reconcile_github_migration(|host, login| {
            checked_host(engine, host, login)
                .ok()
                .map(|(_, account)| account.into())
        })?;
        Ok(())
    }

    /// Binds a workflow to the selected Project login on this host, or to the
    /// currently active login. Every request uses the verified credential.
    pub fn github_account_for_project(
        &self,
        engine: &Engine,
        project: Option<&str>,
        host: &str,
    ) -> Result<(Engine, ConnectionInfo), Error> {
        let host = normalized_host(host)?;
        let login = self.github_project_login(project, &host)?;
        Ok(checked_host(engine, &host, login.as_deref())?)
    }
}

pub(super) fn is_integration_target(source: &ConfiguredSource) -> bool {
    source.saved.provider == GITHUB_INTEGRATION
        && source.saved.config.contains_key(github::SITE_CONFIG)
}

pub(super) fn workflow_target(
    connection: &Connection,
    host: &str,
    project: Option<&str>,
    destinations: &[String],
) -> Result<ConfiguredSource, Error> {
    let login = project_login(connection, project, host)?;
    let revision = serde_json::to_string(&(host, &login))?;
    Ok(workflow_source(
        host,
        login,
        String::new(),
        destinations,
        revision,
    ))
}

pub(super) fn recovery_target(
    host: &str,
    login: Option<String>,
    account_key: Option<String>,
    destination: &str,
) -> ConfiguredSource {
    workflow_source(
        host,
        login,
        account_key.unwrap_or_default(),
        &[destination.to_owned()],
        String::new(),
    )
}

fn workflow_source(
    host: &str,
    login: Option<String>,
    account_key: String,
    destinations: &[String],
    revision: String,
) -> ConfiguredSource {
    let mut config = host_configuration(host, login.as_deref());
    config.insert(super::REPOSITORIES.into(), json!(destinations));
    ConfiguredSource {
        derived: github::legacy_derived_configuration(GITHUB_INTEGRATION, host, &config)
            .unwrap_or_default(),
        saved: SavedSource {
            id: GITHUB_INTEGRATION.into(),
            name: github::DISPLAY_NAME.into(),
            provider: GITHUB_INTEGRATION.into(),
            config,
            account: login.unwrap_or_default(),
            saved_at: String::new(),
            secret_fields: Vec::new(),
            session_secret_fields: Vec::new(),
        },
        revision,
        site: if host == PUBLIC_HOST {
            String::new()
        } else {
            host.into()
        },
        credentials: super::credentials::References::new(),
        permitted_env: Default::default(),
        account_key,
    }
}

pub(super) fn resolve_assignee<'a>(
    provider: &str,
    config: &'a ConfigValues,
    login: &str,
) -> std::borrow::Cow<'a, ConfigValues> {
    if provider == GITHUB_INTEGRATION
        && config.get("assignee").and_then(Value::as_str) == Some("@me")
    {
        let mut config = config.clone();
        config.insert("assignee".into(), json!(login));
        return std::borrow::Cow::Owned(config);
    }
    std::borrow::Cow::Borrowed(config)
}

pub(super) fn forget_device_settings(connection: &Connection) -> Result<(), Error> {
    if crate::backup::table_exists(connection, "github_repository_rules")? {
        connection.execute_batch(
            "DELETE FROM github_repository_status;
             DELETE FROM github_repository_rules;
             DELETE FROM github_project_logins;
             DELETE FROM github_legacy_ticket_bindings;
             DELETE FROM github_legacy_status;
             DELETE FROM github_legacy_repository_rules;
             DELETE FROM github_legacy_accounts;",
        )?;
    }
    Ok(())
}

pub(super) fn retain_device_settings(
    restored: &Connection,
    current: &Connection,
) -> Result<(), Error> {
    for (table, width, guard) in [
        ("github_repository_rules", 6, ""),
        ("github_repository_status", 10, ""),
        ("github_legacy_accounts", 5, ""),
        ("github_legacy_status", 10, ""),
        ("github_legacy_repository_rules", 5, ""),
        (
            "github_project_logins",
            3,
            " WHERE EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
        ),
    ] {
        let mut statement = current.prepare(&format!("SELECT * FROM {table}"))?;
        let mut rows = statement.query([])?;
        let inserts = (1..=width)
            .map(|index| format!("?{index}"))
            .collect::<Vec<_>>()
            .join(",");
        let mut insert =
            restored.prepare(&format!("INSERT INTO {table} SELECT {inserts}{guard}"))?;
        while let Some(row) = rows.next()? {
            let values = (0..width)
                .map(|index| row.get::<_, rusqlite::types::Value>(index))
                .collect::<Result<Vec<_>, _>>()?;
            insert.execute(rusqlite::params_from_iter(values))?;
        }
    }
    let mut statement = current.prepare(
        "SELECT b.ticket_id, b.connection_id, i.external_id FROM github_legacy_ticket_bindings b JOIN external_identities i USING(ticket_id)",
    )?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        restored.execute(
            "INSERT INTO github_legacy_ticket_bindings (ticket_id,connection_id)
             SELECT ticket_id, ?2 FROM external_identities WHERE ticket_id = ?1 AND provider = 'github' AND external_id = ?3",
            params![row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?],
        )?;
    }
    Ok(())
}
