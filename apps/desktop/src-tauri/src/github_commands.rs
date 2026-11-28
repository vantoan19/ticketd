use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use tauri::{Manager, State, Webview, ipc::JavaScriptChannelId};
use tauri_plugin_opener::OpenerExt;
use ticketd_core::source::{
    DiscoveryPreview, Engine, GithubHost, GithubIntegration, GithubRepository,
    GithubRepositoryRule, SourceError, sign_in_github,
};
use tokio::sync::watch;

use crate::{SourceFailure, SourceRegistry, open_workspace, source_task};

#[derive(Clone, Default)]
pub(crate) struct GithubReadinessChecks(
    std::sync::Arc<Mutex<HashMap<String, (Instant, GithubHost)>>>,
);

impl GithubReadinessChecks {
    fn check(
        &self,
        engine: &Engine,
        host: &str,
        retry: bool,
    ) -> Result<GithubHost, ticketd_core::Error> {
        const REUSE: Duration = Duration::from_secs(60);
        if !retry
            && let Ok(checks) = self.0.lock()
            && let Some((checked, readiness)) = checks.get(host)
            && checked.elapsed() < REUSE
        {
            return Ok(readiness.clone());
        }
        let started = Instant::now();
        let readiness = GithubHost::check(engine, host)?;
        if let Ok(mut checks) = self.0.lock() {
            if let Some((checked, newer)) = checks.get(&readiness.host)
                && *checked > started
            {
                return Ok(newer.clone());
            }
            checks.insert(readiness.host.clone(), (started, readiness.clone()));
        }
        Ok(readiness)
    }
}

#[derive(Default)]
pub(crate) struct GithubSignIns(Mutex<HashMap<String, watch::Sender<bool>>>);

struct SignIn<'a> {
    state: &'a GithubSignIns,
    host: String,
}

impl Drop for SignIn<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.state.0.lock() {
            active.remove(&self.host);
        }
    }
}

#[tauri::command]
pub(crate) async fn get_github_integration(
    sources: State<'_, SourceRegistry>,
    readiness: State<'_, GithubReadinessChecks>,
) -> Result<GithubIntegration, SourceFailure> {
    let readiness = readiness.inner().clone();
    source_task(sources, move |registry| {
        let engine = registry.engine()?;
        Ok(
            open_workspace()?.github_integration_with_readiness(&engine, |host| {
                readiness.check(&engine, host, false)
            })?,
        )
    })
    .await
}

#[tauri::command]
pub(crate) async fn get_github_host_readiness(
    sources: State<'_, SourceRegistry>,
    readiness: State<'_, GithubReadinessChecks>,
    host: String,
) -> Result<GithubHost, SourceFailure> {
    let readiness = readiness.inner().clone();
    source_task(sources, move |registry| {
        Ok(readiness.check(&registry.engine()?, &host, true)?)
    })
    .await
}

#[tauri::command]
pub(crate) async fn preview_github_repository(
    sources: State<'_, SourceRegistry>,
    rule: GithubRepositoryRule,
) -> Result<DiscoveryPreview, SourceFailure> {
    source_task(sources, move |registry| {
        Ok(open_workspace()?.preview_github_repository(&registry.engine()?, rule)?)
    })
    .await
}

#[tauri::command]
pub(crate) async fn save_github_repository(
    sources: State<'_, SourceRegistry>,
    rule: GithubRepositoryRule,
) -> Result<GithubRepository, SourceFailure> {
    source_task(sources, move |registry| {
        Ok(open_workspace()?.save_github_repository(&registry.engine()?, rule)?)
    })
    .await
}

#[tauri::command]
pub(crate) async fn remove_github_repository(
    sources: State<'_, SourceRegistry>,
    repository: String,
) -> Result<(), SourceFailure> {
    source_task(sources, move |_| {
        Ok(open_workspace()?.remove_github_repository(&repository)?)
    })
    .await
}

#[tauri::command]
pub(crate) async fn set_github_project_login(
    sources: State<'_, SourceRegistry>,
    project_id: String,
    host: String,
    login: Option<String>,
) -> Result<(), SourceFailure> {
    source_task(sources, move |registry| {
        Ok(open_workspace()?.set_github_project_login(
            &registry.engine()?,
            &project_id,
            &host,
            login.as_deref(),
        )?)
    })
    .await
}

#[tauri::command]
pub(crate) async fn start_github_sign_in(
    webview: Webview,
    host: String,
    codes: JavaScriptChannelId,
    sessions: State<'_, GithubSignIns>,
    readiness: State<'_, GithubReadinessChecks>,
) -> Result<GithubHost, SourceFailure> {
    let host = host.trim().to_ascii_lowercase();
    let (cancel, pending) = watch::channel(false);
    {
        let mut active = sessions
            .0
            .lock()
            .map_err(|_| SourceError::Unavailable("GitHub sign-in could not start.".into()))?;
        if active.contains_key(&host) {
            return Err(SourceError::Unavailable(
                "GitHub sign-in is already running for this host.".into(),
            )
            .into());
        }
        active.insert(host.clone(), cancel);
    }
    let _sign_in = SignIn {
        state: &sessions,
        host: host.clone(),
    };
    let channel = codes.channel_on(webview.clone());
    let app = webview.app_handle().clone();
    sign_in_github(
        &host,
        pending,
        |code| channel.send(code).map_err(|_| SourceError::RefreshCanceled),
        |url| {
            app.opener().open_url(url, None::<&str>).map_err(|_| {
                SourceError::Unavailable("The browser could not open GitHub sign-in.".into())
            })
        },
    )
    .await?;
    let readiness = readiness.inner().clone();
    source_task(webview.state(), move |registry| {
        Ok(readiness.check(&registry.engine()?, &host, true)?)
    })
    .await
}

#[tauri::command]
pub(crate) fn cancel_github_sign_in(
    host: String,
    sessions: State<'_, GithubSignIns>,
) -> Result<(), SourceFailure> {
    let state = sessions
        .0
        .lock()
        .map_err(|_| SourceError::Unavailable("GitHub sign-in could not be canceled.".into()))?;
    if let Some(cancel) = state.get(&host.trim().to_ascii_lowercase()) {
        let _ = cancel.send(true);
    }
    Ok(())
}
