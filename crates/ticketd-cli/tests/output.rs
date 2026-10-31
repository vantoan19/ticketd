#[cfg(unix)]
#[test]
fn closed_stdout_reports_an_error_without_panicking() {
    use std::{
        os::unix::net::UnixStream,
        process::{Command, Stdio},
    };

    let directory =
        std::env::temp_dir().join(format!("ticketd-output-test-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let (reader, writer) = UnixStream::pair().unwrap();
    drop(reader);
    let result = Command::new(env!("CARGO_BIN_EXE_ticketd"))
        .arg("list")
        .env("HOME", &directory)
        .env("XDG_DATA_HOME", &directory)
        .stdout(Stdio::from(std::os::fd::OwnedFd::from(writer)))
        .output()
        .unwrap();
    std::fs::remove_dir_all(directory).unwrap();
    assert_eq!(result.status.code(), Some(1));
    let stderr = String::from_utf8(result.stderr).unwrap();
    assert!(stderr.starts_with("error:"), "{stderr}");
    assert!(!stderr.contains("panicked"), "{stderr}");
}
