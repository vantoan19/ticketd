//! The choices agy lists without opening an ACP session.
use std::path::Path;
use std::process::Stdio;

use crate::stdio::{Serving, command, read_probe_output};
use crate::{CHECK_TIMEOUT, ModelChoice, SettingOption};

const MAX_MODEL_LIST_BYTES: usize = 64 * 1024;

const EFFORTS: &[(&str, &str)] = &[
    ("low", "Low"),
    ("medium", "Medium"),
    ("high", "High"),
    ("xhigh", "XHigh"),
    ("max", "Max"),
];

pub(super) async fn listed(executable: &Path) -> Vec<ModelChoice> {
    let mut command = command(executable, &["models"], Serving::Nothing);
    command
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .env("AGY_CLI_DISABLE_AUTO_UPDATE", "1");
    let output = tokio::time::timeout(CHECK_TIMEOUT, async {
        let mut child = command.spawn().ok()?;
        // The command kills its child on drop if the read fails or times out.
        let output = read_probe_output(child.stdout.take()?, "stdout", MAX_MODEL_LIST_BYTES)
            .await
            .ok()?;
        child.wait().await.ok()?.success().then_some(output)
    })
    .await;
    match output {
        Ok(Some(output)) => parse(&String::from_utf8_lossy(&output)),
        _ => Vec::new(),
    }
}

fn option(id: &str, label: &str) -> SettingOption {
    SettingOption {
        id: id.to_owned(),
        label: label.to_owned(),
        description: None,
        is_default: false,
        permission: None,
        allowed: true,
    }
}

fn parse(output: &str) -> Vec<ModelChoice> {
    let mut models = Vec::<ModelChoice>::new();
    for line in output.lines() {
        let line = line.trim();
        let Some(boundary) = line.find(char::is_whitespace) else {
            continue;
        };
        let (slug, column) = line.split_at(boundary);
        let name = column.trim();
        if name.is_empty()
            || !(column.starts_with("  ") || column.starts_with('\t'))
            || !slug.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"-._".contains(&byte)
            })
        {
            continue;
        }
        // agy models lists the CLI slug for each effort. ACP selects the model
        // and effort in separate fields, as in its session/new response.
        let (id, label, effort) = slug
            .rsplit_once('-')
            .and_then(|(base, suffix)| {
                let &(effort, label) = EFFORTS.iter().find(|&&(effort, _)| effort == suffix)?;
                let base_name = name.strip_suffix(&format!(" ({label})"))?;
                Some((base, base_name, Some(option(effort, label))))
            })
            .unwrap_or((slug, name, None));
        let index = models.iter().position(|model| model.model.id == id);
        let model = match index {
            Some(index) => &mut models[index],
            None => {
                models.push(ModelChoice {
                    model: option(id, label),
                    efforts: Vec::new(),
                    runs_as: None,
                });
                let index = models.len() - 1;
                &mut models[index]
            }
        };
        if let Some(effort) = effort
            && !model
                .efforts
                .iter()
                .any(|existing| existing.id == effort.id)
        {
            model.efforts.push(effort);
        }
    }
    for model in &mut models {
        model
            .efforts
            .sort_by_key(|effort| EFFORTS.iter().position(|(id, _)| *id == effort.id));
    }
    models
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    #[tokio::test]
    async fn model_probe_rejects_oversized_output_even_with_a_valid_prefix() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        const OUTPUT_BUDGET: usize = 64 * 1024;
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("agy");
        let listing = directory.path().join("listing");
        fs::write(
            &executable,
            "#!/bin/sh\n[ \"$1\" = models ] || exit 2\n\
             printf 'diagnostic-only  Warning\\n' >&2\n\
             exec /bin/cat \"${0%/*}/listing\"\n",
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();

        let mut output = b"test-model  Test Model\n".to_vec();
        output.resize(OUTPUT_BUDGET, b'\n');
        fs::write(&listing, &output).unwrap();
        let models = super::listed(&executable).await;
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].model.id, "test-model");

        output.push(b'\n');
        fs::write(&listing, &output).unwrap();
        assert!(super::listed(&executable).await.is_empty());
    }

    #[test]
    fn listed_models_group_native_efforts_and_keep_fixed_model_names() {
        let models = super::parse(
            "Available models:\n             gemini-4-neon-high     Gemini 4 Neon (High)\n             gemini-4-neon-low      Gemini 4 Neon (Low)\n             gemini-pro-orchestrator-neon    Orchestrator (Neon)\n",
        );
        assert_eq!(models.len(), 2);
        let gemini = &models[0];
        assert_eq!(gemini.model.id, "gemini-4-neon");
        assert_eq!(gemini.model.label, "Gemini 4 Neon");
        assert_eq!(
            gemini
                .efforts
                .iter()
                .map(|effort| effort.id.as_str())
                .collect::<Vec<_>>(),
            ["low", "high"],
        );
        let orchestrator = &models[1];
        assert_eq!(orchestrator.model.id, "gemini-pro-orchestrator-neon");
        assert!(orchestrator.efforts.is_empty());
    }
}
