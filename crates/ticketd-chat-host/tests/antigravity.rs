//! The real Antigravity registration and Chat host against a synthetic agy on PATH.
#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::panic)] // test setup and assertions

use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
    time::Duration,
};

use ticketd_chat_host::{
    ChatHost, ChatProblem, ChatView, HostResources, ProblemKind, SendMode, SettingChangeState,
    SettingKey, StartSettings, registration,
};
use ticketd_core::{Chat, ChatItem, ChatTurnState, NewChat, Workspace, WorkspaceSession};

const HARNESS: &str = "antigravity";
const FIXTURE_DIR: &str = "TICKETD_TEST_AGY_PERMISSION_FIXTURE";

fn chat_at(workspace: &Path, folder: &Path) -> Chat {
    fs::create_dir(folder).unwrap();
    Workspace::open(workspace.join("workspace.sqlite3"))
        .unwrap()
        .create_chat(
            None,
            NewChat {
                title: None,
                harness: HARNESS.to_owned(),
                execution_folder: folder.to_str().unwrap().to_owned(),
                folder_managed: false,
                links: Vec::new(),
            },
        )
        .unwrap()
}

fn host_at(workspace: &Path) -> ChatHost {
    let path = workspace.join("workspace.sqlite3");
    let adapter = (registration(HARNESS).unwrap().make_adapter)(&HostResources {
        executable_directory: None,
    })
    .unwrap();
    ChatHost::new(
        Arc::new(move || WorkspaceSession::for_file(&path)?.workspace()),
        vec![adapter],
    )
    .unwrap()
}

async fn wait_for(host: &ChatHost, chat: &Chat, matches: impl Fn(&ChatView) -> bool) -> ChatView {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let (view, mut updates) = host.attach(&chat.id).await.unwrap();
            if matches(&view) {
                return view;
            }
            updates.next().await.unwrap();
        }
    })
    .await
    .unwrap()
}

async fn wait_for_turn(host: &ChatHost, chat: &Chat, completed: usize) -> ChatView {
    let view = wait_for(host, chat, |view| {
        view.live.problem.is_some()
            || view
                .snapshot
                .items
                .iter()
                .filter(|item| {
                    matches!(item, ChatItem::Turn(turn) if turn.state == ChatTurnState::Completed)
                })
                .count()
                == completed
    })
    .await;
    assert_eq!(view.live.problem, None);
    view
}

fn assert_permission(view: &ChatView, permission: &str) {
    let settings = view.live.settings.as_ref().unwrap();
    let shown = settings.reported.permission.as_ref().unwrap();
    assert_eq!(shown.current.as_deref(), Some(permission));
}

async fn reopens_with_permission(workspace: &Path, permission: &str) {
    let folder = workspace.join(permission);
    let chat = chat_at(workspace, &folder);
    let host = host_at(workspace);
    host.start_with(
        &chat.id,
        StartSettings {
            permission: Some(permission.to_owned()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    host.send(&chat.id, None, "First prompt", SendMode::Auto)
        .await
        .unwrap();
    let first = wait_for_turn(&host, &chat, 1).await;
    assert_permission(&first, permission);
    assert_eq!(
        first.snapshot.chat.effective_settings.as_deref(),
        Some(format!(r#"{{"permission":"{permission}"}}"#).as_str()),
        "the first confirmed permission is saved with the Chat"
    );
    assert!(host.quit().await.is_empty());
    drop(host);

    let restarted = host_at(workspace);
    let (idle, _) = restarted.attach(&chat.id).await.unwrap();
    assert_permission(&idle, permission);
    restarted
        .send(&chat.id, None, "Second prompt", SendMode::Auto)
        .await
        .unwrap();
    assert_permission(&wait_for_turn(&restarted, &chat, 2).await, permission);
    assert!(restarted.quit().await.is_empty());

    let calls = fs::read_to_string(folder.join("agy.calls")).unwrap();
    let launch = if permission == "full-access" {
        "launch acp --dangerously-skip-permissions"
    } else {
        "launch acp"
    };
    let mut expected = Vec::new();
    for open in ["new", "resume fixture-session"] {
        expected.extend([launch, open]);
        if permission == "accept-edits" {
            expected.push("configure accept-edits");
        }
        expected.push("prompt");
    }
    assert_eq!(calls.lines().collect::<Vec<_>>(), expected);
}

async fn refused_startup_keeps_the_unconfigured_chat(workspace: &Path) {
    let folder = workspace.join("refused");
    let chat = chat_at(workspace, &folder);
    let host = host_at(workspace);
    host.start_with(
        &chat.id,
        StartSettings {
            permission: Some("accept-edits".to_owned()),
            effort: Some("high".to_owned()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    host.send(&chat.id, None, "Held prompt", SendMode::Auto)
        .await
        .unwrap();
    let failed = wait_for(&host, &chat, |view| view.live.problem.is_some()).await;
    assert!(matches!(
        failed.live.problem,
        Some(ChatProblem::OpenFailed { problem, .. })
            if problem.kind == ProblemKind::PermissionUnavailable
    ));
    assert!(!failed.live.running);
    assert_eq!(failed.snapshot.chat.effective_settings, None);
    assert!(host.quit().await.is_empty());
    let calls = fs::read_to_string(folder.join("agy.calls")).unwrap();
    assert_eq!(
        calls.lines().collect::<Vec<_>>(),
        [
            "launch acp",
            "new",
            "configure accept-edits",
            "configure high"
        ]
    );
}

#[tokio::test]
async fn initial_permission_survives_host_restart_once_confirmed() {
    let Some(path) = std::env::var_os(FIXTURE_DIR) else {
        run_with_fixture("initial_permission_survives_host_restart_once_confirmed");
        return;
    };
    let workspace = Path::new(&path);
    for permission in ["full-access", "accept-edits", "own"] {
        reopens_with_permission(workspace, permission).await;
    }
    refused_startup_keeps_the_unconfigured_chat(workspace).await;
}

#[tokio::test]
async fn permission_restart_retains_effort_when_the_held_model_offers_it() {
    let Some(path) = std::env::var_os(FIXTURE_DIR) else {
        run_with_fixture("permission_restart_retains_effort_when_the_held_model_offers_it");
        return;
    };
    let workspace = Path::new(&path);
    for (model, effort) in [("quick", "minimal"), ("balanced", "high")] {
        let (host, chat, folder) = restart_with_held_model(workspace, model, None).await;
        let resumed = wait_for_turn(&host, &chat, 2).await;
        assert_permission(&resumed, "full-access");
        assert_eq!(
            resumed.snapshot.chat.effective_settings.as_deref(),
            Some(r#"{"permission":"full-access"}"#)
        );
        let settings = &resumed.live.settings.as_ref().unwrap().reported;
        assert_eq!(
            settings.model.as_ref().unwrap().current.as_deref(),
            Some(model)
        );
        assert_eq!(
            settings.effort.as_ref().unwrap().current.as_deref(),
            Some(effort)
        );
        assert_eq!(
            resumed.snapshot.chat.native_session_id.as_deref(),
            Some("fixture-session")
        );
        assert!(host.quit().await.is_empty());
        let calls = fs::read_to_string(folder.join("agy.calls")).unwrap();
        let mut expected = restart_calls(model);
        if model == "balanced" {
            expected.push("configure high".to_owned());
        }
        expected.push(format!("prompt {model} {effort}"));
        assert_eq!(calls.lines().collect::<Vec<_>>(), expected);
    }
}

#[tokio::test]
async fn permission_restart_refuses_an_unsupported_explicit_effort_before_the_queued_prompt() {
    let Some(path) = std::env::var_os(FIXTURE_DIR) else {
        run_with_fixture(
            "permission_restart_refuses_an_unsupported_explicit_effort_before_the_queued_prompt",
        );
        return;
    };
    let (host, chat, folder) =
        restart_with_held_model(Path::new(&path), "quick", Some("low")).await;
    let failed = wait_for(&host, &chat, |view| view.live.problem.is_some()).await;
    assert!(matches!(
        failed.live.problem,
        Some(ChatProblem::OpenFailed { problem, native_resume: true })
            if problem.kind == ProblemKind::Other
    ));
    assert!(failed.snapshot.chat.queue_paused);
    assert!(host.quit().await.is_empty());
    let calls = fs::read_to_string(folder.join("agy.calls")).unwrap();
    assert_eq!(calls.lines().collect::<Vec<_>>(), restart_calls("quick"));
}

async fn restart_with_held_model(
    workspace: &Path,
    model: &str,
    effort: Option<&str>,
) -> (ChatHost, Chat, PathBuf) {
    let folder = workspace.join(format!("held-{model}"));
    let chat = chat_at(workspace, &folder);
    let host = host_at(workspace);
    host.start_with(
        &chat.id,
        StartSettings {
            effort: Some("high".to_owned()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    host.send(&chat.id, None, "First prompt", SendMode::Auto)
        .await
        .unwrap();
    let first = wait_for(&host, &chat, |view| {
        view.live.problem.is_some()
            || view.snapshot.items.iter().any(
                |item| matches!(item, ChatItem::Turn(turn) if turn.state == ChatTurnState::Active),
            )
    })
    .await;
    assert_eq!(first.live.problem, None);
    for (setting, value) in [
        (SettingKey::Permission, Some("full-access")),
        (SettingKey::Model, Some(model)),
        (SettingKey::Effort, effort),
    ] {
        let Some(value) = value else { continue };
        assert_eq!(
            host.change_setting(&chat.id, setting, value).await.unwrap(),
            SettingChangeState::Held
        );
    }
    host.send(&chat.id, None, "Queued prompt", SendMode::Queue)
        .await
        .unwrap();
    fs::write(folder.join("agy.release"), "").unwrap();
    (host, chat, folder)
}

fn restart_calls(model: &str) -> Vec<String> {
    vec![
        "launch acp".to_owned(),
        "new".to_owned(),
        "configure high".to_owned(),
        "prompt initial high".to_owned(),
        "launch acp --dangerously-skip-permissions".to_owned(),
        "resume fixture-session".to_owned(),
        format!("configure {model}"),
    ]
}

fn run_with_fixture(test: &str) {
    let dir = tempfile::tempdir().unwrap();
    let agy = dir.path().join("agy");
    fs::write(
        &agy,
        include_str!("fixtures/antigravity/permission-restart.sh"),
    )
    .unwrap();
    fs::set_permissions(&agy, fs::Permissions::from_mode(0o700)).unwrap();
    // A child runs the actual registration without changing other tests' PATH.
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", test])
        .env(FIXTURE_DIR, dir.path())
        .env("PATH", dir.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
