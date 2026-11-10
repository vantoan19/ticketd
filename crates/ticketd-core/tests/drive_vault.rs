use ticketd_core::drive::{CredentialStore, DriveCredential, PlatformCredentialStore};

/// Explicit operator-session smoke check; ordinary tests never change the OS vault.
#[test]
#[ignore = "requires an unlocked OS-user credential store; run explicitly for platform verification"]
fn platform_vault_is_shared_by_independent_processes() {
    const CHILD_ID: &str = "TICKETD_DRIVE_VAULT_SMOKE_ID";
    if let Ok(id) = std::env::var(CHILD_ID) {
        let value = PlatformCredentialStore.load(&id).unwrap();
        assert_eq!(value.refresh_token, "ticketd-synthetic-not-a-google-token");
        assert_eq!(value.client_id, "synthetic-client");
        return;
    }
    let id = uuid::Uuid::new_v4().to_string();
    PlatformCredentialStore
        .save(
            &id,
            &DriveCredential {
                client_id: "synthetic-client".into(),
                client_secret: None,
                refresh_token: "ticketd-synthetic-not-a-google-token".into(),
            },
        )
        .unwrap();
    let result = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "platform_vault_is_shared_by_independent_processes",
            "--ignored",
        ])
        .env(CHILD_ID, &id)
        .output();
    let cleanup = keyring::Entry::new("ticketd.google-drive.v1", &id)
        .unwrap()
        .delete_credential();
    let result = result.unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    cleanup.unwrap();
}
