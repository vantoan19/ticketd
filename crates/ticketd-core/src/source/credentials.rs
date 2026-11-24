//! Device-local credential references and per-request resolution.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    env,
    sync::{LazyLock, Mutex},
};

use rusqlite::{Connection, params};
use serde_json::Value;
use uuid::Uuid;

use super::{ConfigSchema, ConfigValues, FieldIssue, FieldKind, SchemaField, SourceError};
use crate::Error;

pub(super) use ticketd_source_sdk::{VALUE_LIMIT, env_part};
const SERVICE: &str = "ticketd.source-secrets.v1";
static SESSION: LazyLock<Mutex<HashMap<Uuid, String>>> = LazyLock::new(Mutex::default);

/// Values are immutable once staged. A successful SQLite commit switches the
/// pointers as a group, so a failed or concurrent edit never replaces a value
/// the saved connection still references.
pub(super) type References = BTreeMap<String, Uuid>;

pub(crate) fn migrate(connection: &Connection) -> Result<(), Error> {
    connection.execute_batch(
        "CREATE TABLE source_secret_references (
             connection_id TEXT NOT NULL REFERENCES source_connections(id) ON DELETE CASCADE,
             field TEXT NOT NULL,
             reference TEXT NOT NULL UNIQUE,
             PRIMARY KEY(connection_id, field)
         )",
    )?;
    Ok(())
}

pub(super) fn references(connection: &Connection, id: &str) -> Result<References, Error> {
    let mut fields = connection.prepare_cached(
        "SELECT field, reference FROM source_secret_references WHERE connection_id = ?1",
    )?;
    let rows = fields.query_map([id], |row| {
        let field: String = row.get(0)?;
        let reference: String = row.get(1)?;
        let reference = Uuid::parse_str(&reference).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                1,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?;
        Ok((field, reference))
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub(super) fn store_references(
    connection: &Connection,
    id: &str,
    references: &References,
) -> Result<(), Error> {
    for (field, reference) in references {
        connection.execute(
            "INSERT INTO source_secret_references (connection_id, field, reference)
             VALUES (?1, ?2, ?3) ON CONFLICT(connection_id, field)
             DO UPDATE SET reference = excluded.reference",
            params![id, field, reference.to_string()],
        )?;
    }
    Ok(())
}

pub(super) fn session_fields(references: &References) -> Vec<String> {
    let values = SESSION.lock().unwrap_or_else(|error| error.into_inner());
    references
        .iter()
        .filter(|(_, reference)| values.contains_key(reference))
        .map(|(field, _)| field.clone())
        .collect()
}

/// Deletes staged credentials on rollback, or the previous credentials on
/// commit. Vault cleanup is best effort and cannot invalidate the SQLite write.
#[derive(Default)]
pub(super) struct Staged {
    pub references: References,
}

impl Staged {
    pub(super) fn save(&mut self, id: &str, field: &str, value: &str) -> Result<(), SourceError> {
        let reference = Uuid::new_v4();
        match vault::set(reference, value) {
            Ok(()) => (),
            #[cfg(target_os = "linux")]
            Err(VaultError::Unavailable) => {
                SESSION
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .insert(reference, value.to_owned());
            }
            Err(error) => return Err(vault_error(error, id, field)),
        }
        self.references.insert(field.to_owned(), reference);
        Ok(())
    }

    pub(super) fn committed(mut self, previous: &References) {
        for field in self.references.keys() {
            if let Some(reference) = previous.get(field) {
                discard(*reference);
            }
        }
        self.references.clear();
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        for reference in self.references.values() {
            discard(*reference);
        }
    }
}

pub(super) fn discard(reference: Uuid) {
    let session = SESSION
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(&reference);
    if session.is_none() && vault::delete(reference).is_err() {
        tracing::warn!("could not remove a source credential from secure storage");
    }
}

fn env_key(id: &str, field: &str) -> String {
    format!("TICKETD_SOURCE_{}_{}", env_part(id), env_part(field))
}

pub(super) fn env_keys(schema: &ConfigSchema, id: &str) -> HashSet<String> {
    schema
        .fields
        .iter()
        .filter(|field| matches!(field.kind, FieldKind::Secret))
        .flat_map(|field| {
            let key = env_key(id, &field.key);
            [format!("{key}_COMMAND"), key]
        })
        .collect()
}

pub(super) fn resolve(
    schema: &ConfigSchema,
    id: &str,
    references: &References,
    permitted_env: Option<&HashSet<String>>,
    raw: &ConfigValues,
) -> Result<ConfigValues, SourceError> {
    let mut result = raw.clone();
    let mut checked = HashSet::new();
    for field in &schema.fields {
        resolve_field(
            schema,
            id,
            references,
            permitted_env,
            field,
            &mut result,
            &mut checked,
        )?;
    }
    Ok(result)
}

fn resolve_field(
    schema: &ConfigSchema,
    id: &str,
    references: &References,
    permitted_env: Option<&HashSet<String>>,
    field: &SchemaField,
    values: &mut ConfigValues,
    checked: &mut HashSet<String>,
) -> Result<(), SourceError> {
    if !checked.insert(field.key.clone()) {
        return Ok(());
    }
    if let Some(parent) = field.show_if.as_deref().and_then(|key| schema.field(key)) {
        resolve_field(
            schema,
            id,
            references,
            permitted_env,
            parent,
            values,
            checked,
        )?;
    }
    if !schema.is_active(field, values) {
        values.remove(&field.key);
        return Ok(());
    }
    if !matches!(field.kind, FieldKind::Secret) {
        return Ok(());
    }
    let supplied = values.remove(&field.key).filter(|value| !value.is_null());
    let candidate = match supplied {
        Some(Value::String(value)) if !value.trim().is_empty() => Some(value),
        Some(other) if !other.is_string() => {
            return Err(invalid(&field.key, "must be a credential string"));
        }
        _ => load(
            id,
            &field.key,
            references.get(&field.key).copied(),
            permitted_env,
        )?,
    };
    let Some(candidate) = candidate else {
        return if field.required {
            Err(needs_sign_in(id, &field.key, "needs a credential"))
        } else {
            Ok(())
        };
    };
    if candidate.trim().is_empty() {
        return Err(needs_sign_in(id, &field.key, "has an empty credential"));
    }
    if candidate.len() > VALUE_LIMIT {
        return Err(invalid(&field.key, "must be at most 64 KiB"));
    }
    field
        .check_secret_pattern(&candidate)
        .map_err(|issue| SourceError::InvalidConfiguration(vec![issue]))?;
    values.insert(field.key.clone(), Value::String(candidate));
    Ok(())
}

fn load(
    id: &str,
    field: &str,
    reference: Option<Uuid>,
    permitted_env: Option<&HashSet<String>>,
) -> Result<Option<String>, SourceError> {
    let read_override = |name: &str| {
        if permitted_env.is_none_or(|permitted| permitted.contains(name)) {
            env::var_os(name)
        } else {
            None
        }
    };
    let name = env_key(id, field);
    if let Some(value) = read_override(&name) {
        return value
            .into_string()
            .map(Some)
            .map_err(|_| invalid(field, "environment override must be valid UTF-8"));
    }
    if let Some(command) = read_override(&format!("{name}_COMMAND")) {
        let command: Vec<String> = command.to_str().and_then(|value| serde_json::from_str(value).ok())
            .filter(|args: &Vec<String>| args.first().is_some_and(|executable| !executable.is_empty()))
            .ok_or_else(|| invalid(field, "password command must be a JSON array containing an executable and its arguments"))?;
        return super::extension::password_output(command)
            .map(Some)
            .map_err(|()| {
                needs_sign_in(
                    id,
                    field,
                    "could not read a credential from the password command",
                )
            });
    }
    let Some(reference) = reference else {
        return Ok(None);
    };
    if let Some(value) = SESSION
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(&reference)
    {
        return Ok(Some(value.clone()));
    }
    vault::get(reference)
        .and_then(|bytes| String::from_utf8(bytes).map_err(|_| VaultError::Failed))
        .map(Some)
        .map_err(|error| vault_error(error, id, field))
}

fn invalid(field: &str, message: &str) -> SourceError {
    SourceError::InvalidConfiguration(vec![FieldIssue::for_field(field, message)])
}

fn needs_sign_in(id: &str, field: &str, message: &str) -> SourceError {
    SourceError::Unauthenticated(format!(
        "{field} {message}. Enter it in Settings → Sources, or set {} before running ticketd",
        env_key(id, field),
    ))
}

#[derive(Debug)]
enum VaultError {
    Missing,
    Unavailable,
    Failed,
    #[cfg(target_os = "windows")]
    TooLong,
}

fn vault_error(error: VaultError, id: &str, field: &str) -> SourceError {
    match error {
        VaultError::Missing => needs_sign_in(id, field, "needs a credential"),
        VaultError::Unavailable => needs_sign_in(
            id,
            field,
            "cannot access its entry in the operating system keychain",
        ),
        VaultError::Failed => {
            SourceError::Unavailable("could not use the source credential store".into())
        }
        #[cfg(target_os = "windows")]
        VaultError::TooLong => invalid(
            field,
            "Windows Credential Manager supports at most 2,560 bytes; use an environment override or password command",
        ),
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod vault {
    use super::*;

    fn use_entry<T>(
        reference: Uuid,
        operation: impl FnOnce(&keyring::Entry) -> Result<T, keyring::Error>,
    ) -> Result<T, VaultError> {
        // The legacy macOS Keychain interaction setting is process-wide.
        #[cfg(target_os = "macos")]
        static NONINTERACTIVE: Mutex<()> = Mutex::new(());
        #[cfg(target_os = "macos")]
        let _serial = NONINTERACTIVE
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        #[cfg(target_os = "macos")]
        let _no_prompt = {
            use security_framework::os::macos::keychain::SecKeychain;
            SecKeychain::user_interaction_allowed()
                .map_err(|_| VaultError::Unavailable)?
                .then(SecKeychain::disable_user_interaction)
                .transpose()
                .map_err(|_| VaultError::Unavailable)?
        };
        let entry = keyring::Entry::new(SERVICE, &reference.to_string()).map_err(map_error)?;
        operation(&entry).map_err(map_error)
    }

    fn map_error(error: keyring::Error) -> VaultError {
        match error {
            keyring::Error::NoEntry => VaultError::Missing,
            keyring::Error::NoStorageAccess(_) => VaultError::Unavailable,
            #[cfg(target_os = "windows")]
            keyring::Error::TooLong(..) => VaultError::TooLong,
            #[cfg(target_os = "macos")]
            keyring::Error::PlatformFailure(error)
                if error
                    .downcast_ref::<security_framework::base::Error>()
                    .is_some_and(|error| matches!(error.code(), -25293 | -25308)) =>
            {
                VaultError::Unavailable
            }
            _ => VaultError::Failed,
        }
    }

    pub(super) fn set(reference: Uuid, value: &str) -> Result<(), VaultError> {
        use_entry(reference, |entry| entry.set_secret(value.as_bytes()))
    }

    pub(super) fn get(reference: Uuid) -> Result<Vec<u8>, VaultError> {
        use_entry(reference, keyring::Entry::get_secret)
    }

    pub(super) fn delete(reference: Uuid) -> Result<(), VaultError> {
        match use_entry(reference, keyring::Entry::delete_credential) {
            Err(VaultError::Missing) => Ok(()),
            result => result,
        }
    }
}

#[cfg(target_os = "linux")]
mod vault {
    use dbus_secret_service::{EncryptionType, Error, Item, SecretService};

    use super::*;

    fn connect() -> Result<SecretService, VaultError> {
        // The keyring backend's default prompt wait is unbounded. Use its pinned
        // underlying Secret Service driver directly to prohibit unlock prompts.
        SecretService::connect_with_max_prompt_timeout(EncryptionType::Dh, 0).map_err(map_error)
    }

    fn map_error(error: Error) -> VaultError {
        match error {
            Error::Locked | Error::Prompt | Error::Unavailable => VaultError::Unavailable,
            Error::Dbus(error)
                if matches!(
                    error.name(),
                    Some(
                        "org.freedesktop.DBus.Error.ServiceUnknown"
                            | "org.freedesktop.DBus.Error.NameHasNoOwner"
                            | "org.freedesktop.DBus.Error.NoServer"
                            | "org.freedesktop.DBus.Error.AccessDenied"
                            | "org.freedesktop.DBus.Error.Disconnected"
                            | "org.freedesktop.DBus.Error.Spawn.ExecFailed"
                            | "org.freedesktop.DBus.Error.FileNotFound"
                            | "org.freedesktop.DBus.Error.NotSupported"
                            | "org.freedesktop.Secret.Error.IsLocked"
                    )
                ) =>
            {
                VaultError::Unavailable
            }
            _ => VaultError::Failed,
        }
    }

    fn attributes(reference: &str) -> HashMap<&str, &str> {
        HashMap::from([("service", SERVICE), ("username", reference)])
    }

    fn find<'a>(service: &'a SecretService, reference: &str) -> Result<Item<'a>, VaultError> {
        let mut items = service
            .search_items(attributes(reference))
            .map_err(map_error)?;
        match (items.unlocked.len(), items.locked.len()) {
            (1, 0) => items.unlocked.pop().ok_or(VaultError::Missing),
            (0, 0) => Err(VaultError::Missing),
            (0, 1) => Err(VaultError::Unavailable),
            _ => Err(VaultError::Failed),
        }
    }

    pub(super) fn set(reference: Uuid, value: &str) -> Result<(), VaultError> {
        let service = connect()?;
        let collection = service
            .get_default_collection()
            .map_err(|error| match error {
                Error::NoResult => VaultError::Unavailable,
                error => map_error(error),
            })?;
        if collection.is_locked().map_err(map_error)? {
            return Err(VaultError::Unavailable);
        }
        collection
            .create_item(
                "ticketd source credential",
                attributes(&reference.to_string()),
                value.as_bytes(),
                false,
                "text/plain",
            )
            .map_err(map_error)?;
        Ok(())
    }

    pub(super) fn get(reference: Uuid) -> Result<Vec<u8>, VaultError> {
        find(&connect()?, &reference.to_string())?
            .get_secret()
            .map_err(map_error)
    }

    pub(super) fn delete(reference: Uuid) -> Result<(), VaultError> {
        match find(&connect()?, &reference.to_string()) {
            Ok(item) => item.delete().map_err(map_error),
            Err(VaultError::Missing) => Ok(()),
            Err(error) => Err(error),
        }
    }
}
