# Install ticketd

## Availability

Public signed releases are not available yet. To run ticketd now, follow
[development setup](development.md). Maintainer workflow artifacts are temporary
inspection builds with seven-day retention, not stable download links. The
instructions below describe those packaged artifacts when one has been supplied.

Each distribution download contains a desktop installer and the matching `ticketd`
CLI. Select macOS 26 on Apple Silicon, Ubuntu 24.04 x86-64, or Windows 11
x86-64. WSL interoperability and mobile distribution are outside this matrix.
These are build artifacts, not signed releases; platform validation remains
necessary before a public release.

- **macOS:** Open the DMG and drag ticketd to Applications. Copy `ticketd` to a
  directory on your PATH, for example `~/.local/bin`, and ensure it is executable.
- **Ubuntu:** Install the `.deb` with `sudo apt install ./ticketd_*.deb` from
  the extracted download. Copy `ticketd` to `~/.local/bin` and add that directory
  to PATH if necessary. The package manager installs desktop dependencies.
- **Windows:** Run the MSI installer. Copy `ticketd.exe` to a user directory on
  PATH (for example `%LOCALAPPDATA%\Programs\ticketd-cli`) and add that directory
  to the user's PATH in Windows environment settings. Restart terminals and agent
  harnesses so they inherit the updated PATH.

Run `ticketd --version` and `ticketd --help` in the same environment as the
external harness. Supply the absolute path to the executable if the harness
cannot discover it on PATH. Desktop and CLI use the same default workspace for
the same operating-system user and environment; launch both under that user.
On Linux `XDG_DATA_HOME` changes the location, so set it consistently for both.
Registered project paths belong to the native OS environment; see
[CLI project context](cli.md#project-context) for registration commands.

## Upgrades and removal

Use desktop and CLI from the same version. Run `ticketd workspace` to inspect the
path and supported format without changing data. Most other workspace commands
may create or migrate the database. Back up before upgrading; an older binary
may refuse a newer workspace, and downgrade compatibility is not guaranteed.
Close both desktop and CLI processes before replacing binaries or restoring a backup.
See [workspace operations](../crates/ticketd-cli/skill-data/workspace.md) for backup
and restore commands and [export documentation](export.md) for what they preserve.

Uninstall the desktop through the OS or package manager and remove the copied
CLI executable. The workspace is stored separately in the user's application-data
directory and is retained. Keep a backup before uninstalling or upgrading.

## Agent CLI skill

The CLI contains an offline operating guide, matching the executable's version:

```sh
ticketd skills get
ticketd skills list
ticketd skills get writes
```

`get` prints Markdown; `list` returns JSON with the CLI version and guide names.
Topic guides cover tickets, context (Documents, Activities, and Plans), writes,
sources, workspace operations, and working from a ticketd Chat (`chat`). Command-specific `--help` remains the argument
reference. All `skills` commands work without opening, creating, or migrating the
ticket workspace.

Install the small discovery skill for your user from Settings → Agent skills in
the desktop app, or with the CLI:

```sh
ticketd skills install --harness claude-code,codex
```

Claude Code reads it from `~/.claude/skills/ticketd` (or `$CLAUDE_CONFIG_DIR/skills`),
Codex from `~/.agents/skills/ticketd`. To install for one project instead, pass its
skill directory, for example `ticketd skills install .claude/skills/ticketd` or
`.agents/skills/ticketd`. Other harnesses can use the same portable `SKILL.md` in
their skill directory, or load the guide directly with `ticketd skills get`.

ticketd writes a `.ticketd-managed` marker beside each `SKILL.md` it installs.
Re-running installation updates a copy ticketd wrote and nobody changed, and leaves
an identical one alone. A copy edited after installation, or one ticketd did not
write, is reported and left intact. Review it, then choose Replace in Settings or
pass `--replace`: the existing `SKILL.md` is saved beside the new one as
`SKILL.md.backup-<seconds>`. Adjacent files and project instructions are preserved.
Restart or reload the harness if needed to discover an installed skill. Keep
`ticketd` on that harness's PATH or supply its absolute executable path.

The skill teaches CLI operations. It does not select a tracker, automatically
create tickets, or impose a work lifecycle. If useful, add this capability pointer
to your project's instructions:

```text
When interacting with ticketd, use the ticketd skill or load `ticketd skills get`.
```

Users and their other skills decide which work belongs in ticketd and how to
organize it. Installing this skill does not change those choices.

## Signing and distribution

The manual build workflow uploads unsigned artifacts for inspection and does not
publish a release or configure credentials. macOS distribution outside the App
Store requires a Developer ID Application certificate and Apple notarization
credentials; unsigned downloads may be blocked by Gatekeeper. Windows code
signing requires an appropriate certificate and signing configuration; unsigned
installers can trigger SmartScreen or be blocked by Smart App Control. See the
[Tauri macOS signing guide](https://v2.tauri.app/distribute/sign/macos/) and
[Windows signing guide](https://v2.tauri.app/distribute/sign/windows/). Signing,
notarization, and platform installation must be verified with real credentials
and target systems before distribution.

## Google Drive setup

Distribution builds include ticketd's Google app registration. In the attachment
picker, choose **Google Drive > Choose in Google Drive**, sign in in your default
browser, and select the files to authorize. To upload new copies, choose a writable
Drive folder in **Settings > Attachments**. Users do not need a Google Cloud project,
a configuration file, or environment variables. Local attachments also work
without signing in. A source build without a registration keeps Drive disabled
and explains that a build with Drive enabled is needed.

Use an unlocked OS-user secure store: Windows Credential Manager, macOS Keychain,
or a running Secret Service session on Linux. Desktop and CLI must run as the same
OS user to share authorization. An unavailable store produces recovery guidance;
there is no file-based credential fallback. Restoring a backup on another machine
restores reference metadata, not credentials or remote bytes; select files again
with the appropriate account. External Testing refresh tokens may expire after
seven days under Google's OAuth policy.

### Publisher and developer configuration

The publisher enables Google Drive API and Google Picker API in its Google Cloud
project, configures consent with only `https://www.googleapis.com/auth/drive.file`,
and creates **Desktop app** OAuth clients for the supported platforms. For an
External Testing app, add the test users. Configure these repository secrets with
the matching downloaded installed-app JSON:

- `TICKETD_GOOGLE_OAUTH_CLIENT_JSON_MACOS`
- `TICKETD_GOOGLE_OAUTH_CLIENT_JSON_LINUX`
- `TICKETD_GOOGLE_OAUTH_CLIENT_JSON_WINDOWS`

Enable the APIs in the same project that owns these OAuth clients; creating a
client alone does not enable Drive API access. If sign-in and folder selection
succeed but ticketd reports that Google Drive API is disabled, the publisher must
[enable it in Google Cloud](https://developers.google.com/workspace/guides/enable-apis),
allow the change to take effect, then retry. End users do not perform this setup.

The distribution workflow embeds the matching registration in both desktop and
CLI via the build-time `TICKETD_GOOGLE_OAUTH_CLIENT_JSON` variable. Missing or
invalid registration fails distribution before installers are published. Local
builds can supply that same variable during compilation. Keep the JSON outside
Git and workspace/backup storage. Desktop clients are public clients; bundling
their registration never bundles a user's authorization or refresh token.

Developers can explicitly override a bundled registration by setting
`TICKETD_GOOGLE_OAUTH_CLIENT_FILE` to an external Desktop OAuth JSON file in the
process environment and restarting ticketd. A missing or invalid override reports
an error rather than silently switching registrations. Unset it to use the
bundled registration. The application pins Google's authorization/token/API
endpoints rather than trusting endpoints in either JSON source.

The native Picker integration requires validation with your configured desktop
client and account before a complete Drive release is claimed. Fixture tests do
not establish live OAuth/Picker, account policy or packaged secure-store behavior.
Primary contracts: [native Picker](https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker),
[desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app),
[per-file scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth),
and [OAuth expiration](https://developers.google.com/identity/protocols/oauth2#expiration).
