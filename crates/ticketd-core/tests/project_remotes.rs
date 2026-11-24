use ticketd_core::{ProjectRemoteChange, Workspace};

#[test]
fn a_project_remote_is_reserved_case_insensitively_until_cleared() {
    let dir = tempfile::tempdir().unwrap();
    let mut workspace = Workspace::open(dir.path().join("workspace.db")).unwrap();
    let alpha_checkout = dir.path().join("alpha");
    let beta_checkout = dir.path().join("beta");
    std::fs::create_dir(&alpha_checkout).unwrap();
    std::fs::create_dir(&beta_checkout).unwrap();
    let alpha_checkout = alpha_checkout.to_str().unwrap();
    let beta_checkout = beta_checkout.to_str().unwrap();

    let alpha = workspace
        .create_project_with_remote(
            "Alpha",
            alpha_checkout,
            Some("GHE.Example.com/Team/Package"),
        )
        .unwrap();
    assert_eq!(
        alpha.remote.as_deref(),
        Some("ghe.example.com/Team/Package")
    );
    assert_eq!(workspace.show_project(&alpha.id).unwrap(), alpha);

    let remote = "ghe.example.com/TEAM/package";
    let error = workspace
        .create_project_with_remote("Beta", beta_checkout, Some(remote))
        .unwrap_err();
    assert!(error.to_string().contains("Alpha"));

    let beta = workspace.create_project("Beta", beta_checkout).unwrap();
    let error = workspace
        .edit_project_with_remote(
            &beta.id,
            "Renamed Beta",
            beta_checkout,
            ProjectRemoteChange::Set(remote),
        )
        .unwrap_err();
    assert!(error.to_string().contains("Alpha"));
    assert_eq!(workspace.show_project(&beta.id).unwrap(), beta);

    let renamed = workspace
        .edit_project(&alpha.id, "Renamed Alpha", alpha_checkout)
        .unwrap();
    assert_eq!(renamed.remote, alpha.remote);
    assert_eq!(
        workspace
            .edit_project_with_remote(
                &alpha.id,
                &renamed.name,
                alpha_checkout,
                ProjectRemoteChange::Clear
            )
            .unwrap()
            .remote,
        None
    );
    assert_eq!(
        workspace
            .edit_project_with_remote(
                &beta.id,
                &beta.name,
                beta_checkout,
                ProjectRemoteChange::Set(remote)
            )
            .unwrap()
            .remote
            .as_deref(),
        Some(remote)
    );
}

#[test]
fn project_remotes_survive_workspace_export_and_backup_restore() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.db");
    let backup = dir.path().join("backup.db");
    let mut workspace = Workspace::open(&path).unwrap();
    let remote = "github.example.com/Team/Package";
    let checkout = dir.path().to_str().unwrap();
    let project = workspace
        .create_project_with_remote("Package", checkout, Some(remote))
        .unwrap();

    assert_eq!(workspace.export().unwrap()["projects"][0]["remote"], remote);

    workspace.backup(&backup).unwrap();
    workspace
        .edit_project_with_remote(
            &project.id,
            &project.name,
            checkout,
            ProjectRemoteChange::Clear,
        )
        .unwrap();

    drop(workspace);
    Workspace::restore(&path, &backup).unwrap();
    let workspace = Workspace::open(&path).unwrap();
    assert_eq!(workspace.list_projects().unwrap(), vec![project]);
}
