# Testing Google Drive

The Drive integration has three separate verification layers. A provider fixture
can prove a failure contract, while live Google checks establish API and account
compatibility. Desktop verification also needs real IPC and native dialogs.

## Deterministic regression suite

Run `./scripts/check-drive` from a checkout with the pinned Rust and npm toolchains
and installed frontend dependencies. On Windows, run it through Git Bash. It uses
temporary databases, synthetic inputs and deterministic provider responses; it
does not access a Google account. Two test workers are the default to avoid
resource starvation. `./scripts/check` remains the final repository quality gate.

The focused suite covers publisher configuration, OAuth and Picker validation,
account/file identity, scoped authorization, resumable upload/reconciliation,
destination binding, access recovery, uploaded-copy inspection and byte export,
portable links, backup exclusion of credentials and remote bytes, protected
removal, and the shared editor's upload/recovery interactions.

Environment-gated migration and OS-vault tests report as ignored in the ordinary
suite. Run them explicitly with their documented prerequisites when those
boundaries change. An ignored test is never evidence that its gate passed.

## Live Google and native desktop

The opt-in runner under `tests/live` uses a publisher-configured standalone CLI,
an explicitly provided authorized connection and writable folder, and an isolated
Workspace. Follow its help for parameters. It creates uniquely named synthetic
files and preserves remote files for inspection. Keep its reports under ignored
`target` output. Do not commit credentials or use a personal Workspace as a fixture.

Live assertions include upload/download byte hashes, chunk boundaries, request
replay across processes, destination preservation and non-overwriting exports.
Fault injection, revocation and destructive lifecycle checks belong in isolated
fixtures; do not disrupt a person's real Google grant to manufacture a failure.

Desktop acceptance additionally checks system-browser consent and folder/file
selection, actual file and Save dialogs, upload progress/cancel/retry, persistence
across restart, editor insertion order and valid saved Markdown, and recovery
after backup restoration. Inspect changed screens in light, dark and compact
layouts, with keyboard focus and long filenames. An installed build and a QA host
are distinct forms of evidence; record which one ran.

For browser automation, follow the machine's browser-profile instructions before
launching a browser. On managed Windows machines, a new unseeded Chromium profile
can cause account lockouts. Do not bypass those instructions for test isolation.

## Hardening gate

Track the acceptance matrix, findings and execution evidence in GitHub Issues.
For each confirmed bug: reproduce it, add a regression that fails first, apply
the fix, then rerun the original scenario and affected suites. Rerun live tests
against the rebuilt artifacts after code changes; record the binary hash and
source revision alongside the results.

Release clearance requires green deterministic and feasible live/native checks,
no unresolved accepted requirement defects, and explicit results for the target
platforms. Mark unavailable account, native-input and platform checks as blocked
or not run. Passing Windows checks do not establish Linux/macOS secure-store or
OAuth behavior, and a clean run does not prove the absence of undiscovered bugs.
