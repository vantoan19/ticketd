# Install ticketd

## Availability

Download ticketd from [GitHub Releases](https://github.com/vantoan19/ticketd/releases).
Releases before 1.0 are **unsigned previews**: they are not code signed or
notarized, so macOS and Windows warn before the first launch (see below). To
build from source instead, follow [development setup](development.md).

Each release has a desktop installer and the matching `ticketd` CLI for macOS 26
on Apple Silicon, Ubuntu 24.04 x86-64, and Windows 11 x86-64, plus `SHA256SUMS`.
Check a download with `shasum -a 256 -c SHA256SUMS --ignore-missing` (macOS),
`sha256sum -c SHA256SUMS --ignore-missing` (Linux), or by comparing
`Get-FileHash <file>` with its line (Windows). WSL interoperability and mobile
distribution are outside this matrix.

- **macOS:** Open the `.dmg` and drag ticketd to Applications. Extract the
  `ticketd-cli-*-macos-arm64.tar.gz` archive and move `ticketd` to a directory on
  your PATH, for example `~/.local/bin`. Because the build is unsigned, remove the
  download quarantine from both before the first launch:

  ```sh
  xattr -dr com.apple.quarantine /Applications/ticketd.app
  xattr -d com.apple.quarantine ~/.local/bin/ticketd
  ```

  Alternatively, try to open the app once, then choose **Open Anyway** in System
  Settings → Privacy & Security.

- **Ubuntu:** Install the `.deb` with `sudo apt install ./ticketd_*.deb`. Extract
  the `ticketd-cli-*-linux-x86_64.tar.gz` archive, move `ticketd` to
  `~/.local/bin`, and add that directory to PATH if necessary. The package manager
  installs desktop dependencies.
- **Windows:** Run the `.msi` installer. SmartScreen warns about an unrecognized
  app: choose **More info**, then **Run anyway**. If Smart App Control is on, it
  blocks unsigned installers outright; build from source instead. Extract
  `ticketd-cli-*-windows-x86_64.zip` and move `ticketd.exe` to a user directory
  on PATH (for example `%LOCALAPPDATA%\Programs\ticketd-cli`), then add that
  directory to the user's PATH in Windows environment settings. Restart terminals
  and agent harnesses so they inherit the updated PATH.

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
Settings uses the app's own `CLAUDE_CONFIG_DIR`, or your login shell's when the app
was started from the Finder or Dock.

ticketd writes a `.ticketd-managed` marker beside each `SKILL.md` it installs,
holding the hash of what it wrote and its version. Re-running installation updates a
copy an older or the same ticketd wrote and nobody changed, and leaves an identical
one, or one a newer ticketd wrote, alone. A copy edited after installation, or one ticketd did not
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

Releases are unsigned previews until signing is set up; see
[release and distribution](releasing.md#publish-a-public-release). The manual
Package workflow uploads unsigned artifacts for inspection and does not publish a
release. macOS distribution outside the App Store requires a Developer ID
Application certificate and Apple notarization credentials; unsigned downloads
are blocked by Gatekeeper until the quarantine is removed as shown above. Windows code
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
and creates one **Desktop app** OAuth client, which serves every platform. For an
External Testing app, add the test users. Store the downloaded installed-app JSON
as the `TICKETD_GOOGLE_OAUTH_CLIENT_JSON` repository secret.

Enable the APIs in the same project that owns the OAuth client; creating a
client alone does not enable Drive API access. If sign-in and folder selection
succeed but ticketd reports that Google Drive API is disabled, the publisher must
[enable it in Google Cloud](https://developers.google.com/workspace/guides/enable-apis),
allow the change to take effect, then retry. End users do not perform this setup.

The distribution workflow embeds that registration in both desktop and
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
