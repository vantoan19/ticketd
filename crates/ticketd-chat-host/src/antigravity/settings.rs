//! ACP configuration values and the two permission choices supplied by ticketd.
use agent_client_protocol_schema::v1 as acp;
use serde::{Deserialize, Serialize};
use ticketd_core::harnesses::{ANTIGRAVITY, PermissionAvailability};

use crate::{AppliesFrom, HarnessSettings, Setting, SettingKey, SettingOption};

pub(super) const OWN: &str = "own";
pub(super) const FULL: &str = "full-access";

#[derive(Default, Deserialize, Serialize)]
pub(super) struct Record {
    pub permission: Option<String>,
}

impl Record {
    pub fn read(record: Option<&str>) -> Self {
        record
            .and_then(|record| serde_json::from_str(record).ok())
            .unwrap_or_default()
    }
}

pub(super) fn select(
    configs: &[acp::SessionConfigOption],
    setting: SettingKey,
) -> Option<(&acp::SessionConfigId, &acp::SessionConfigSelect)> {
    let category = match setting {
        SettingKey::Model => acp::SessionConfigOptionCategory::Model,
        SettingKey::Effort => acp::SessionConfigOptionCategory::ThoughtLevel,
        SettingKey::Permission => acp::SessionConfigOptionCategory::Mode,
    };
    configs.iter().find_map(|config| {
        if config.category.as_ref() == Some(&category)
            && let acp::SessionConfigKind::Select(select) = &config.kind
        {
            Some((&config.id, select))
        } else {
            None
        }
    })
}

pub(super) fn options(select: &acp::SessionConfigSelect) -> Vec<&acp::SessionConfigSelectOption> {
    match &select.options {
        acp::SessionConfigSelectOptions::Ungrouped(options) => options.iter().collect(),
        acp::SessionConfigSelectOptions::Grouped(groups) => {
            groups.iter().flat_map(|group| &group.options).collect()
        }
        _ => Vec::new(),
    }
}

pub(super) fn update_mode(
    configs: &mut [acp::SessionConfigOption],
    mode: acp::SessionModeId,
) -> bool {
    let select = configs.iter_mut().find_map(|config| {
        if config.category == Some(acp::SessionConfigOptionCategory::Mode)
            && let acp::SessionConfigKind::Select(select) = &mut config.kind
        {
            Some(select)
        } else {
            None
        }
    });
    if let Some(select) = select
        && options(select)
            .iter()
            .any(|option| option.value.0 == mode.0)
    {
        // This legacy notification can update an existing ACP config choice.
        // A later configuration snapshot replaces the value again.
        select.current_value = acp::SessionConfigValueId::new(mode.0);
        return true;
    }
    false
}

fn setting(current: Option<&str>, options: Vec<SettingOption>) -> Setting {
    Setting {
        current: current.map(str::to_owned),
        options,
        unchangeable: None,
        applies_from: AppliesFrom::NextTurn,
        answered_by: None,
    }
}

pub(super) fn permission(configs: &[acp::SessionConfigOption], current: Option<&str>) -> Setting {
    let native = select(configs, SettingKey::Permission)
        .map(|(_, select)| options(select))
        .unwrap_or_default();
    let offered = ANTIGRAVITY
        .permissions
        .iter()
        .filter_map(|choice| {
            let option = native
                .iter()
                .find(|option| option.value.0.as_ref() == choice.id);
            if choice.availability == PermissionAvailability::Native
                && option.is_none()
                && current != Some(choice.id)
            {
                return None;
            }
            let mut shown = SettingOption::from_permission(
                choice,
                choice.availability != PermissionAvailability::Native || option.is_some(),
            );
            if let Some(native) = option {
                shown.description.clone_from(&native.description);
            }
            Some(shown)
        })
        .collect();
    setting(current, offered)
}

pub(super) fn reported(
    configs: &[acp::SessionConfigOption],
    current_permission: Option<&str>,
) -> HarnessSettings {
    let choice = |key| {
        let (_, select) = select(configs, key)?;
        Some(setting(
            Some(select.current_value.0.as_ref()),
            options(select)
                .into_iter()
                .map(|option| SettingOption {
                    id: option.value.0.to_string(),
                    label: option.name.clone(),
                    description: option.description.clone(),
                    is_default: false,
                    permission: None,
                    allowed: true,
                })
                .collect(),
        ))
    };
    HarnessSettings {
        model: choice(SettingKey::Model),
        effort: choice(SettingKey::Effort),
        permission: Some(permission(configs, current_permission)),
    }
}
