//! What a folder says about itself, read on demand and never stored: the git branch
//! checked out in it, and the favicon a Project's folder ships. Only files are read;
//! no git process runs and nothing in the folder changes.
use std::path::{Component, Path, PathBuf};

/// The branch of the repository a folder is in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Branch {
    Named(String),
    /// A checked-out commit, shortened as git shortens it.
    Detached(String),
    /// The folder is in a repository whose HEAD could not be read.
    Unreadable,
}

/// The git directory of the repository `folder` is in: `.git` itself, or the one a
/// `.git` file names (a linked worktree or submodule).
fn git_dir(folder: &Path) -> Option<PathBuf> {
    folder.ancestors().find_map(|dir| {
        let dot_git = dir.join(".git");
        if dot_git.is_dir() {
            return Some(dot_git);
        }
        let text = std::fs::read_to_string(&dot_git).ok()?;
        let named = text.trim().strip_prefix("gitdir:")?.trim();
        Some(dir.join(named))
    })
}

/// `None` when the folder is not in a git repository.
pub fn branch(folder: &Path) -> Option<Branch> {
    let head = git_dir(folder)?.join("HEAD");
    let Ok(text) = std::fs::read_to_string(head) else {
        return Some(Branch::Unreadable);
    };
    let text = text.trim();
    if let Some(reference) = text.strip_prefix("ref:") {
        let reference = reference.trim();
        let name = reference.strip_prefix("refs/heads/").unwrap_or(reference);
        return Some(if name.is_empty() {
            Branch::Unreadable
        } else {
            Branch::Named(name.to_owned())
        });
    }
    let commit = text.len() >= 40 && text.chars().all(|c| c.is_ascii_hexdigit());
    Some(match text.get(..7) {
        Some(short) if commit => Branch::Detached(short.to_owned()),
        _ => Branch::Unreadable,
    })
}

/// A favicon's bytes and media type, for the Project icon.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Favicon {
    pub mime: &'static str,
    pub bytes: Vec<u8>,
}

/// Where web projects keep their favicon, in the order looked at.
const ICON_FOLDERS: [&str; 5] = ["", "public", "static", "app", "src"];
const ICON_NAMES: [&str; 5] = [
    "favicon.svg",
    "favicon.png",
    "favicon.ico",
    "icon.svg",
    "icon.png",
];
/// A favicon is small; anything larger is not one.
const MAX_ICON_BYTES: u64 = 512 * 1024;

fn mime(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match extension.as_str() {
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => return None,
    })
}

fn read_icon(path: &Path) -> Option<Favicon> {
    let mime = mime(path)?;
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_ICON_BYTES {
        return None;
    }
    Some(Favicon {
        mime,
        bytes: std::fs::read(path).ok()?,
    })
}

/// The `href` of each `<link rel="… icon …">` in an HTML page, in order. A rough scan,
/// not a parser: a page that hides its icon from it just gets the letter tile.
fn icon_links(html: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let attribute = |tag: &str, original: &str, name: &str| -> Option<String> {
        let at = tag.find(&format!("{name}="))? + name.len() + 1;
        let rest = original.get(at..)?;
        let quote = rest.chars().next()?;
        let value = if quote == '"' || quote == '\'' {
            rest.get(1..)?.split(quote).next()?
        } else {
            rest.split(|c: char| c.is_whitespace() || c == '>').next()?
        };
        Some(value.to_owned())
    };
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(start) = lower.get(from..).and_then(|rest| rest.find("<link")) {
        let start = from + start;
        let end = lower
            .get(start..)
            .and_then(|rest| rest.find('>'))
            .map_or(lower.len(), |end| start + end);
        let (Some(tag), Some(original)) = (lower.get(start..end), html.get(start..end)) else {
            break;
        };
        let rel = attribute(tag, original, "rel").unwrap_or_default();
        if rel
            .to_ascii_lowercase()
            .split_whitespace()
            .any(|word| word == "icon")
            && let Some(href) = attribute(tag, original, "href")
        {
            found.push(href);
        }
        from = end;
    }
    found
}

/// A link's path inside the folder, or `None` for one that leaves it or is not a file.
fn inside(href: &str) -> Option<PathBuf> {
    if href.contains("://") || href.starts_with("data:") || href.starts_with("//") {
        return None;
    }
    let path = href.split(['?', '#']).next()?.trim_start_matches('/');
    let relative = PathBuf::from(path);
    relative
        .components()
        .all(|part| matches!(part, Component::Normal(_)))
        .then_some(relative)
}

/// The favicon a Project's folder ships, looked for where web projects keep one,
/// then as the icon an `index.html` links to.
pub fn favicon(folder: &Path) -> Option<Favicon> {
    for dir in ICON_FOLDERS {
        for name in ICON_NAMES {
            if let Some(icon) = read_icon(&folder.join(dir).join(name)) {
                return Some(icon);
            }
        }
    }
    for dir in ICON_FOLDERS {
        let page = folder.join(dir).join("index.html");
        let Ok(html) = std::fs::read_to_string(&page) else {
            continue;
        };
        for href in icon_links(&html) {
            let Some(relative) = inside(&href) else {
                continue;
            };
            // "/favicon.svg" is served from the web root, which is the page's folder
            // or a public folder beside it.
            let candidates = [
                folder.join(dir).join(&relative),
                folder.join("public").join(&relative),
            ];
            if let Some(icon) = candidates.iter().find_map(|path| read_icon(path)) {
                return Some(icon);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn branch_reads_head_without_running_git() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("web-app");
        let nested = repo.join("src/limiter");
        std::fs::create_dir_all(&nested).unwrap();
        assert_eq!(branch(&repo), None, "not a repository yet");

        write(
            &repo.join(".git/HEAD"),
            "ref: refs/heads/rate-limit-logins\n",
        );
        assert_eq!(
            branch(&nested),
            Some(Branch::Named("rate-limit-logins".into()))
        );

        write(
            &repo.join(".git/HEAD"),
            "3f9c2a1d0b8e7f6a5c4d3e2f1a0b9c8d7e6f5a4b\n",
        );
        assert_eq!(branch(&repo), Some(Branch::Detached("3f9c2a1".into())));

        write(&repo.join(".git/HEAD"), "garbage");
        assert_eq!(branch(&repo), Some(Branch::Unreadable));
    }

    #[test]
    fn branch_follows_a_linked_worktree() {
        let root = tempfile::tempdir().unwrap();
        let worktree = root.path().join("wt");
        write(
            &worktree.join(".git"),
            "gitdir: ../main/.git/worktrees/wt\n",
        );
        write(
            &root.path().join("main/.git/worktrees/wt/HEAD"),
            "ref: refs/heads/feature/x",
        );
        assert_eq!(branch(&worktree), Some(Branch::Named("feature/x".into())));
    }

    #[test]
    fn favicon_is_found_where_web_projects_keep_it() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(favicon(root.path()), None);
        write(&root.path().join("public/favicon.png"), "png");
        write(&root.path().join("src/favicon.svg"), "<svg/>");
        // public/ comes before src/.
        assert_eq!(
            favicon(root.path()),
            Some(Favicon {
                mime: "image/png",
                bytes: b"png".to_vec()
            })
        );
    }

    #[test]
    fn favicon_follows_index_html_but_never_leaves_the_folder() {
        let root = tempfile::tempdir().unwrap();
        let outside = root.path().join("secret.svg");
        write(&outside, "<svg/>");
        let project = root.path().join("site");
        write(
            &project.join("index.html"),
            r#"<head><link rel="stylesheet" href="a.css"><link rel="icon" href="../secret.svg"><link href="/brand/mark.svg?v=2" rel="shortcut icon"></head>"#,
        );
        assert_eq!(favicon(&project), None, "mark.svg is not there yet");
        write(&project.join("public/brand/mark.svg"), "<svg>mark</svg>");
        assert_eq!(
            favicon(&project).map(|icon| (icon.mime, icon.bytes)),
            Some(("image/svg+xml", b"<svg>mark</svg>".to_vec()))
        );
    }
}
