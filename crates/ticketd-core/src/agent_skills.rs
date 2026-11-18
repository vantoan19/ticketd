//! Installs the bundled ticketd discovery skill into agent harnesses' skill folders.
//!
//! Each installed copy has a marker beside it holding the hash of the `SKILL.md`
//! ticketd wrote and the version that wrote it. Install and update only touch
//! copies an older or the same ticketd wrote and nobody changed; any other copy
//! is replaced only on request, after a backup.
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::io::{Error, ErrorKind, Write};
use std::path::{Path, PathBuf};

/// The discovery skill shipped with this build.
pub const DISCOVERY_SKILL: &str = include_str!("../../../skills/ticketd/SKILL.md");
const SKILL_FILE: &str = "SKILL.md";
const MARKER_FILE: &str = ".ticketd-managed";
const SKILL_NAME: &str = "ticketd";
/// The version recorded in the marker, so a newer copy is never downgraded.
const VERSION: &str = env!("CARGO_PKG_VERSION");

/// A harness that loads skills from a per-user folder.
pub struct Agent {
    /// Stable identifier used by `--harness` and the desktop bridge.
    pub id: &'static str,
    pub name: &'static str,
    /// Variable that relocates the harness's home folder, when it has one.
    home_env: Option<&'static str>,
    /// The harness's home folder relative to the user's home.
    home: &'static str,
    /// The skills folder relative to the user's home, when it lies outside the harness home.
    skills: Option<&'static [&'static str]>,
}

/// Supported harnesses. Adding one is one row.
pub const AGENTS: &[Agent] = &[
    Agent {
        id: "claude-code",
        name: "Claude Code",
        home_env: Some("CLAUDE_CONFIG_DIR"),
        home: ".claude",
        skills: None,
    },
    Agent {
        id: "codex",
        name: "Codex",
        home_env: Some("CODEX_HOME"),
        home: ".codex",
        // Codex reads per-user skills from ~/.agents/skills, not its own home.
        skills: Some(&[".agents", "skills"]),
    },
];

impl Agent {
    pub fn find(id: &str) -> Option<&'static Agent> {
        AGENTS.iter().find(|agent| agent.id == id)
    }

    fn home(&self, user_home: &Path, env: impl Fn(&str) -> Option<OsString>) -> PathBuf {
        self.home_env
            .and_then(env)
            .filter(|value| !value.is_empty())
            .map_or_else(|| user_home.join(self.home), PathBuf::from)
    }

    /// The folder that holds this harness's copy of the ticketd skill. `env`
    /// looks up the variables that relocate a harness home, such as
    /// `std::env::var_os`.
    pub fn skill_directory(
        &self,
        user_home: &Path,
        env: impl Fn(&str) -> Option<OsString>,
    ) -> PathBuf {
        match self.skills {
            Some(skills) => skills
                .iter()
                .fold(user_home.to_path_buf(), |path, part| path.join(part)),
            None => self.home(user_home, env).join("skills"),
        }
        .join(SKILL_NAME)
    }

    /// Whether the harness has run for this user: its home folder holds
    /// something besides the skills folder, which installing may create itself.
    pub fn detected(&self, user_home: &Path, env: impl Fn(&str) -> Option<OsString>) -> bool {
        std::fs::read_dir(self.home(user_home, env)).is_ok_and(|mut entries| {
            entries.any(|entry| entry.is_ok_and(|entry| entry.file_name() != "skills"))
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillState {
    /// The copy matches this build.
    Installed,
    /// ticketd wrote the copy, nobody changed it, and this build ships another version.
    UpdateAvailable,
    /// A newer ticketd wrote the copy and nobody changed it; this build leaves it alone.
    Newer,
    NotInstalled,
    /// ticketd wrote the copy and someone changed it since.
    Edited,
    /// The copy was not written by ticketd, or its marker cannot be read.
    Other,
    /// `SKILL.md` is a link or folder. ticketd never writes through or over it.
    NotAFile,
}

#[derive(Debug, PartialEq, Eq)]
pub enum InstallOutcome {
    Unchanged,
    Installed,
    Updated,
    /// The previous `SKILL.md` was saved at this path first.
    Replaced {
        backup: PathBuf,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum InstallError {
    /// The copy is someone else's; installing needs an explicit replacement.
    #[error("{0}; review it, then replace it to install this version")]
    Conflict(&'static str),
    #[error("SKILL.md is a link or folder; remove it, then install again")]
    NotAFile,
    #[error(transparent)]
    Io(#[from] Error),
}

fn hash(content: &[u8]) -> String {
    Sha256::digest(content)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Reads the state of the skill copy in `directory`.
pub fn skill_state(directory: &Path) -> std::io::Result<SkillState> {
    let path = directory.join(SKILL_FILE);
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(SkillState::NotInstalled),
        Err(error) => return Err(error),
    };
    if !metadata.is_file() {
        return Ok(SkillState::NotAFile);
    }
    let content = std::fs::read(&path)?;
    if content == DISCOVERY_SKILL.as_bytes() {
        return Ok(SkillState::Installed);
    }
    // A marker that is missing, unreadable, or not text proves nothing about
    // who wrote the copy, so the copy is treated as someone else's.
    let Ok(marker) = std::fs::read_to_string(directory.join(MARKER_FILE)) else {
        return Ok(SkillState::Other);
    };
    // Line one is the hash of what ticketd wrote; line two, when present, the
    // version that wrote it. Markers from before versions were recorded have none.
    let mut lines = marker.lines().map(str::trim);
    if lines.next() != Some(hash(&content).as_str()) {
        return Ok(SkillState::Edited);
    }
    Ok(match lines.next() {
        Some(written_by) if is_newer(written_by, VERSION) => SkillState::Newer,
        _ => SkillState::UpdateAvailable,
    })
}

/// Whether release `version` comes after `than`, comparing their numeric
/// `major.minor.patch` parts. A version that does not parse is not newer, so
/// the copy updates as it did before versions were recorded.
fn is_newer(version: &str, than: &str) -> bool {
    fn release(version: &str) -> Option<Vec<u64>> {
        version
            .split(['-', '+'])
            .next()?
            .split('.')
            .map(|part| part.parse().ok())
            .collect()
    }
    matches!((release(version), release(than)), (Some(version), Some(than)) if version > than)
}

/// Copies `SKILL.md` to a backup name no existing file uses.
fn back_up(directory: &Path) -> std::io::Result<PathBuf> {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs());
    let content = std::fs::read(directory.join(SKILL_FILE))?;
    for attempt in 0..1000 {
        let name = match attempt {
            0 => format!("{SKILL_FILE}.backup-{seconds}"),
            _ => format!("{SKILL_FILE}.backup-{seconds}-{attempt}"),
        };
        let backup = directory.join(name);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&backup)
        {
            Ok(mut file) => {
                file.write_all(&content)?;
                file.sync_all()?;
                return Ok(backup);
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
    Err(Error::other(
        "cannot choose a free backup name for SKILL.md",
    ))
}

/// Installs or updates the bundled skill in `directory`.
///
/// An edited or foreign copy is left alone unless `replace` is set, in which
/// case it is first saved beside the new one as `SKILL.md.backup-<seconds>`.
pub fn install_skill(directory: &Path, replace: bool) -> Result<InstallOutcome, InstallError> {
    let state = skill_state(directory)?;
    let path = directory.join(SKILL_FILE);
    let backup = match state {
        SkillState::Installed => {
            write_marker(directory);
            return Ok(InstallOutcome::Unchanged);
        }
        // Its marker stays as the newer ticketd wrote it.
        SkillState::Newer => return Ok(InstallOutcome::Unchanged),
        SkillState::NotAFile => return Err(InstallError::NotAFile),
        SkillState::NotInstalled | SkillState::UpdateAvailable => None,
        SkillState::Edited if !replace => {
            return Err(InstallError::Conflict(
                "SKILL.md was edited after ticketd installed it",
            ));
        }
        SkillState::Other if !replace => {
            return Err(InstallError::Conflict(
                "SKILL.md was not installed by ticketd",
            ));
        }
        SkillState::Edited | SkillState::Other => Some(back_up(directory)?),
    };

    std::fs::create_dir_all(directory)?;
    // Stage beside the destination so a failed write never leaves a partial skill.
    let mut staged = tempfile::NamedTempFile::new_in(directory)?;
    staged.write_all(DISCOVERY_SKILL.as_bytes())?;
    staged.flush()?;
    if state == SkillState::NotInstalled {
        staged
            .persist_noclobber(&path)
            .map_err(|error| error.error)?;
    } else {
        staged.persist(&path).map_err(|error| error.error)?;
    }
    write_marker(directory);
    Ok(match (state, backup) {
        (_, Some(backup)) => InstallOutcome::Replaced { backup },
        (SkillState::NotInstalled, None) => InstallOutcome::Installed,
        _ => InstallOutcome::Updated,
    })
}

/// Records what ticketd wrote. Best effort: the skill is already in place, and
/// without a marker a later version asks before replacing it rather than
/// updating silently, which is the safe direction.
fn write_marker(directory: &Path) {
    let _ignored = std::fs::write(
        directory.join(MARKER_FILE),
        format!("{}\n{VERSION}\n", hash(DISCOVERY_SKILL.as_bytes())),
    );
}

/// The user's home folder.
pub fn user_home() -> std::io::Result<PathBuf> {
    directories::BaseDirs::new()
        .map(|dirs| dirs.home_dir().to_path_buf())
        .ok_or_else(|| Error::new(ErrorKind::NotFound, "cannot find your home folder"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn states_follow_who_wrote_the_copy_and_whether_it_changed() {
        let dir = tempfile::tempdir().unwrap();
        let skill = dir.path().join(SKILL_FILE);
        assert_eq!(skill_state(dir.path()).unwrap(), SkillState::NotInstalled);

        assert_eq!(
            install_skill(dir.path(), false).unwrap(),
            InstallOutcome::Installed
        );
        assert_eq!(skill_state(dir.path()).unwrap(), SkillState::Installed);
        assert_eq!(
            install_skill(dir.path(), false).unwrap(),
            InstallOutcome::Unchanged
        );

        // An older ticketd copy nobody touched updates without asking.
        std::fs::write(&skill, "older ticketd skill").unwrap();
        std::fs::write(dir.path().join(MARKER_FILE), hash(b"older ticketd skill")).unwrap();
        assert_eq!(
            skill_state(dir.path()).unwrap(),
            SkillState::UpdateAvailable
        );
        assert_eq!(
            install_skill(dir.path(), false).unwrap(),
            InstallOutcome::Updated
        );

        // A user's edit is kept until replacement, which saves it first.
        std::fs::write(&skill, "user edit").unwrap();
        assert_eq!(skill_state(dir.path()).unwrap(), SkillState::Edited);
        assert!(matches!(
            install_skill(dir.path(), false),
            Err(InstallError::Conflict(_))
        ));
        assert_eq!(std::fs::read_to_string(&skill).unwrap(), "user edit");
        let InstallOutcome::Replaced { backup } = install_skill(dir.path(), true).unwrap() else {
            panic!("expected a replacement");
        };
        assert_eq!(std::fs::read_to_string(backup).unwrap(), "user edit");
        assert_eq!(skill_state(dir.path()).unwrap(), SkillState::Installed);
    }

    #[test]
    fn a_copy_written_by_a_newer_ticketd_is_never_downgraded() {
        let dir = tempfile::tempdir().unwrap();
        let skill = dir.path().join(SKILL_FILE);
        let marker = dir.path().join(MARKER_FILE);
        std::fs::write(&skill, "newer ticketd skill").unwrap();
        let written_by = |version: &str| {
            std::fs::write(
                &marker,
                format!("{}\n{version}\n", hash(b"newer ticketd skill")),
            )
            .unwrap();
        };

        written_by("999.0.0");
        assert_eq!(skill_state(dir.path()).unwrap(), SkillState::Newer);
        for replace in [false, true] {
            assert_eq!(
                install_skill(dir.path(), replace).unwrap(),
                InstallOutcome::Unchanged
            );
        }
        assert_eq!(
            std::fs::read_to_string(&skill).unwrap(),
            "newer ticketd skill"
        );
        assert_eq!(skill_state(dir.path()).unwrap(), SkillState::Newer);

        // The same or an older version, or none recorded, updates as before.
        for version in [VERSION, "0.0.1", "not a version"] {
            written_by(version);
            assert_eq!(
                skill_state(dir.path()).unwrap(),
                SkillState::UpdateAvailable
            );
        }

        // Installing records this build's version beside the hash.
        install_skill(dir.path(), false).unwrap();
        let marker = std::fs::read_to_string(&marker).unwrap();
        assert_eq!(
            marker.lines().collect::<Vec<_>>(),
            [hash(DISCOVERY_SKILL.as_bytes()).as_str(), VERSION]
        );
    }

    #[test]
    fn versions_compare_by_their_release_numbers() {
        assert!(is_newer("0.10.0", "0.9.3"));
        assert!(is_newer("1.0.0-beta.1", "0.9.0"));
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.2.0"));
        assert!(!is_newer("garbage", "0.1.0"));
    }

    #[test]
    fn a_harness_is_detected_by_its_own_files_not_by_the_skills_folder() {
        let home = tempfile::tempdir().unwrap();
        let unset = |_: &str| None;
        let claude = Agent::find("claude-code").unwrap();
        assert!(!claude.detected(home.path(), unset));

        // Installing creates ~/.claude/skills; that alone is not Claude Code.
        install_skill(&claude.skill_directory(home.path(), unset), false).unwrap();
        assert!(!claude.detected(home.path(), unset));

        std::fs::write(home.path().join(".claude").join("settings.json"), "{}").unwrap();
        assert!(claude.detected(home.path(), unset));
    }

    #[test]
    fn a_foreign_or_unprovable_copy_needs_replacement_and_every_replacement_keeps_its_backup() {
        let dir = tempfile::tempdir().unwrap();
        let skill = dir.path().join(SKILL_FILE);
        std::fs::write(&skill, "first").unwrap();
        assert_eq!(skill_state(dir.path()).unwrap(), SkillState::Other);

        // A marker that is not text is no proof of ownership, and does not block Replace.
        std::fs::write(dir.path().join(MARKER_FILE), [0xff, 0xfe, 0x00]).unwrap();
        assert_eq!(skill_state(dir.path()).unwrap(), SkillState::Other);

        // Two replacements in the same second keep both earlier copies.
        let mut backups = Vec::new();
        for content in ["first", "second"] {
            std::fs::write(&skill, content).unwrap();
            std::fs::remove_file(dir.path().join(MARKER_FILE)).unwrap();
            let InstallOutcome::Replaced { backup } = install_skill(dir.path(), true).unwrap()
            else {
                panic!("expected a replacement");
            };
            backups.push(std::fs::read_to_string(backup).unwrap());
        }
        assert_eq!(backups, ["first", "second"]);
    }

    #[test]
    fn a_folder_named_skill_md_is_reported_and_never_replaced() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(SKILL_FILE)).unwrap();
        assert_eq!(skill_state(dir.path()).unwrap(), SkillState::NotAFile);
        assert!(matches!(
            install_skill(dir.path(), true),
            Err(InstallError::NotAFile)
        ));
        assert!(dir.path().join(SKILL_FILE).is_dir());
    }

    #[test]
    fn claude_code_honors_its_config_folder_and_codex_uses_the_shared_folder() {
        let home = Path::new("/home/user");
        let unset = |_: &str| None;
        let config = |name: &str| (name == "CLAUDE_CONFIG_DIR").then(|| "/profile".into());
        let claude = Agent::find("claude-code").unwrap();
        assert_eq!(
            claude.skill_directory(home, unset),
            home.join(".claude").join("skills").join("ticketd")
        );
        assert_eq!(
            claude.skill_directory(home, config),
            Path::new("/profile").join("skills").join("ticketd")
        );
        let codex = Agent::find("codex").unwrap();
        assert_eq!(
            codex.skill_directory(home, config),
            home.join(".agents").join("skills").join("ticketd")
        );
    }
}
