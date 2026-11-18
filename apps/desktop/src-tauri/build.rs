fn main() {
    stamp_commit();
    tauri_build::build()
}

/// Puts the short commit hash in `TICKETD_COMMIT`, for the diagnostics summary. A build
/// outside a checkout, or without the tool, stamps nothing and the summary says `unknown`.
fn stamp_commit() {
    use std::process::Command;
    println!("cargo:rerun-if-env-changed=TICKETD_COMMIT");
    if let Some(commit) = std::env::var_os("TICKETD_COMMIT") {
        println!(
            "cargo:rustc-env=TICKETD_COMMIT={}",
            commit.to_string_lossy()
        );
        return;
    }
    let run = |args: &[&str]| {
        let output = Command::new("git").args(args).output().ok()?;
        let text = String::from_utf8(output.stdout).ok()?;
        (output.status.success() && !text.trim().is_empty()).then(|| text.trim().to_string())
    };
    // HEAD's log grows with every commit; HEAD itself does not change on a branch.
    if let Some(log) = run(&["rev-parse", "--git-path", "logs/HEAD"]) {
        println!("cargo:rerun-if-changed={log}");
    }
    if let Some(commit) = run(&["rev-parse", "--short=10", "HEAD"]) {
        println!("cargo:rustc-env=TICKETD_COMMIT={commit}");
    }
}
