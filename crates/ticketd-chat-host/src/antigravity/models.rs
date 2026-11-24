//! The choices agy lists without opening an ACP session.
use std::path::Path;
use std::process::Stdio;

use crate::stdio::{Serving, command};
use crate::{CHECK_TIMEOUT, ModelChoice, SettingOption};

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
        .env("AGY_CLI_DISABLE_AUTO_UPDATE", "1");
    match tokio::time::timeout(CHECK_TIMEOUT, command.output()).await {
        Ok(Ok(output)) if output.status.success() => {
            parse(&String::from_utf8_lossy(&output.stdout))
        }
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
