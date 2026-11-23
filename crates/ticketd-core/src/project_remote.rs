use std::{path::Path, process::Command};

use serde::{Deserialize, Serialize};
use url::{Host, Url};

/// Normalize a hosted Git remote URL to a Project remote.
pub fn normalize_project_remote_url(input: &str) -> Option<String> {
    let input = input.trim();
    if input.contains(|c: char| c.is_whitespace() || c.is_control() || c == '\\') {
        return None;
    }
    let (host, path) = if let Some((_, endpoint)) = input.split_once("://") {
        // Use the original path: the URL parser can collapse an invalid dot segment.
        let (authority, path) = endpoint.split_once('/')?;
        let url = Url::parse(input).ok()?;
        if authority.is_empty()
            || !matches!(url.scheme(), "https" | "http" | "ssh" | "git")
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return None;
        }
        (url.host_str()?.to_owned(), path)
    } else {
        let (host, path) = if input.starts_with('[') || input.contains("@[") {
            let (host, path) = input.split_once("]:")?;
            (format!("{host}]"), path)
        } else {
            let (host, path) = input.split_once(':')?;
            // A single-letter prefix also denotes a local Windows drive.
            if host.len() == 1 {
                return None;
            }
            (host.to_owned(), path)
        };
        let host = match host.split_once('@') {
            Some((user, host)) if !user.is_empty() => host.to_owned(),
            Some(_) => return None,
            None => host,
        };
        (host, path)
    };
    let path = path.strip_suffix(".git").unwrap_or(path);
    normalize_project_remote(&format!("{host}/{path}"))
}

/// Validate and canonicalize an already specified Project remote.
pub(crate) fn normalize_project_remote(input: &str) -> Option<String> {
    let (host, path) = input.trim().split_once('/')?;
    let (owner, name) = path.split_once('/')?;
    let valid_part = |part: &str| {
        !matches!(part, "" | "." | "..")
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
    };
    if !valid_part(owner) || !valid_part(name) {
        return None;
    }
    let host = match Host::parse(host).ok()? {
        Host::Domain(domain)
            if domain.trim_end_matches('.').split('.').all(|label| {
                label.starts_with(|c: char| c.is_ascii_alphanumeric())
                    && label.ends_with(|c: char| c.is_ascii_alphanumeric())
                    && label
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            }) =>
        {
            domain.to_ascii_lowercase()
        }
        Host::Domain(_) => return None,
        host => host.to_string(),
    };
    Some(format!("{host}/{owner}/{name}"))
}

/// The checkout's valid hosted remotes, with a preferred Project remote when one is named
/// upstream or origin.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectRemoteDetection {
    pub suggested: Option<String>,
    /// Valid alternatives, or all candidates if there is no suggestion.
    pub candidates: Vec<ProjectRemoteCandidate>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectRemoteCandidate {
    pub name: String,
    pub remote: String,
}

/// Inspect the checkout locally. Git and hosted remotes are both optional.
pub fn detect_project_remote(checkout: &Path) -> ProjectRemoteDetection {
    let Ok(output) = Command::new("git")
        .arg("-C")
        .arg(checkout)
        .args(["remote", "-v"])
        // A caller can run inside a Git hook for an unrelated checkout.
        .env_remove("GIT_DIR")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_WORK_TREE")
        .output()
    else {
        return ProjectRemoteDetection::default();
    };
    if !output.status.success() {
        return ProjectRemoteDetection::default();
    }
    let mut candidates: Vec<_> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let (name, url) = line.strip_suffix(" (fetch)")?.split_once('\t')?;
            Some(ProjectRemoteCandidate {
                name: name.to_owned(),
                remote: normalize_project_remote_url(url)?,
            })
        })
        .collect();
    candidates.sort_by(|a, b| a.name.cmp(&b.name));
    let preferred = ["upstream", "origin"].into_iter().find_map(|name| {
        candidates
            .iter()
            .position(|candidate| candidate.name == name)
    });
    ProjectRemoteDetection {
        suggested: preferred.map(|index| candidates.remove(index).remote),
        candidates,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ProjectRemoteCandidate, ProjectRemoteDetection, detect_project_remote,
        normalize_project_remote_url,
    };
    use std::{path::Path, process::Command};

    #[test]
    fn git_remote_urls_preserve_repository_identity() {
        for url in [
            "git@GitHub.Example.com:Team/Package.git",
            "ssh://git@GitHub.Example.com:2222/Team/Package.git",
            "https://user:token@GitHub.Example.com:8443/Team/Package",
            "https://GitHub.Example.com/Team/Package.git",
        ] {
            assert_eq!(
                normalize_project_remote_url(url).as_deref(),
                Some("github.example.com/Team/Package"),
                "{url}"
            );
        }

        for url in [
            "https://github.example.com/Package",
            "https://github.example.com/Team/Package/extra",
            "https://github.example.com/Team/../Other/Package",
            "https://github.example.com/Team/Package?token=value",
            "https://github.example.com:bad/Team/Package",
            "git@github.example.com:/Team/Package",
            "/local/Team/Package.git",
            "file:///Team/Package",
            "not a URL",
        ] {
            assert_eq!(normalize_project_remote_url(url), None, "{url}");
        }
    }

    #[test]
    fn checkout_suggests_upstream_then_origin_and_offers_other_remotes() {
        let dir = tempfile::tempdir().unwrap();
        let checkout = dir.path();
        assert_eq!(
            detect_project_remote(checkout),
            ProjectRemoteDetection::default()
        );
        git(checkout, &["init", "--quiet", "--template="]);
        git(
            checkout,
            &[
                "remote",
                "add",
                "mirror",
                "ssh://ghe.example.com/Team/Mirror",
            ],
        );
        let mirror = ProjectRemoteCandidate {
            name: "mirror".to_owned(),
            remote: "ghe.example.com/Team/Mirror".to_owned(),
        };
        assert_eq!(
            detect_project_remote(checkout),
            ProjectRemoteDetection {
                suggested: None,
                candidates: vec![mirror.clone()]
            }
        );

        git(
            checkout,
            &[
                "remote",
                "add",
                "origin",
                "git@ghe.example.com:Person/Fork.git",
            ],
        );
        git(checkout, &["remote", "add", "upstream", "/local/checkout"]);
        assert_eq!(
            detect_project_remote(checkout),
            ProjectRemoteDetection {
                suggested: Some("ghe.example.com/Person/Fork".to_owned()),
                candidates: vec![mirror.clone()],
            }
        );

        git(
            checkout,
            &[
                "remote",
                "set-url",
                "upstream",
                "https://ghe.example.com/Team/Package",
            ],
        );
        assert_eq!(
            detect_project_remote(checkout),
            ProjectRemoteDetection {
                suggested: Some("ghe.example.com/Team/Package".to_owned()),
                candidates: vec![
                    mirror,
                    ProjectRemoteCandidate {
                        name: "origin".to_owned(),
                        remote: "ghe.example.com/Person/Fork".to_owned(),
                    },
                ],
            }
        );
    }

    #[allow(clippy::unwrap_used)]
    fn git(checkout: &Path, args: &[&str]) {
        assert!(
            Command::new("git")
                .arg("-C")
                .arg(checkout)
                .args(args)
                .status()
                .unwrap()
                .success()
        );
    }
}
