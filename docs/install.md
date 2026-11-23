# Install ticketd

## Availability

Download ticketd from [GitHub Releases](https://github.com/vantoan19/ticketd/releases).
Releases before 1.0 are **unsigned previews**: they are not code signed or
notarized, so macOS and Windows warn before the first launch (see below). To
build from source instead, follow [development setup](development.md).

Each release has a desktop installer with the matching `ticketd` CLI bundled
for macOS 26 on Apple Silicon, Ubuntu 24.04 x86-64, and Windows 11 x86-64.
Releases also provide standalone CLI archives and `SHA256SUMS`.
Check a download with `shasum -a 256 -c SHA256SUMS --ignore-missing` (macOS),
`sha256sum -c SHA256SUMS --ignore-missing` (Linux), or by comparing
`Get-FileHash <file>` with its line (Windows). WSL interoperability and mobile
distribution are outside this matrix.

- **On macOS**, open the `.dmg` and drag ticketd to Applications. Remove the download
  quarantine before the first launch.

  ```sh
  xattr -dr com.apple.quarantine /Applications/ticketd.app
  ```

  Alternatively, try to open the app once, then choose **Open Anyway** in System
  Settings → Privacy & Security.

- **On Ubuntu**, install the `.deb` with `sudo apt install ./ticketd_*.deb`. The
  package manager installs desktop dependencies.
- **On Windows**, run the `.msi` installer. When SmartScreen warns about an
  unrecognized app, choose **More info**, then **Run anyway**. If Smart App
  Control is on, it blocks unsigned installers outright. Follow
  [development setup](development.md) to build from source.

Open ticketd and [create your first ticket](first-ticket.md).

## Command-line tool

The bundled CLI updates with the desktop. On macOS and Windows, open
**Settings → Command line** and choose **Install command-line tool** to make
`ticketd` available on your PATH.

- **On macOS**, approve the administrator prompt to create a link in
  `/usr/local/bin`. If you decline, ticketd creates the link in `~/.local/bin`.
  Add that directory to PATH and open a new terminal. If you move the app, use
  **Install command-line tool** again to repair the link.
- **On Ubuntu**, the `.deb` already installs `ticketd` in `/usr/bin`.
- **On Windows**, ticketd adds the app's folder to your user PATH. Restart terminals
  and agent harnesses so they inherit the change.

If an older standalone `ticketd` comes first on PATH, **Settings → Command line**
shows its version and path. Choose **Remove it** and confirm to remove that file
or link, or choose **Keep it**. Use **Check again** to confirm which copy is found.

On machines without the desktop, download the standalone archive for your
platform (`ticketd-cli-*-macos-arm64.tar.gz`, `ticketd-cli-*-linux-x86_64.tar.gz`,
or `ticketd-cli-*-windows-x86_64.zip`). Extract the executable and move it to a
directory on your PATH, such as `~/.local/bin` on macOS and Linux or
`%LOCALAPPDATA%\Programs\ticketd-cli` on Windows. Add the directory to PATH if
needed. On macOS, remove the quarantine attribute from the extracted executable
with `xattr -d com.apple.quarantine ~/.local/bin/ticketd` (use its actual path).
Update a standalone CLI by downloading the new archive and replacing the executable.

Run `ticketd --version` and `ticketd --help` in the same environment as the
external harness. Supply the absolute path to the executable if the harness
cannot discover it on PATH. Desktop and CLI use the same default workspace for
the same operating-system user and environment; launch both under that user.
On Linux `XDG_DATA_HOME` changes the location, so set it consistently for both.
Registered project paths belong to the native OS environment; see
[CLI project context](cli.md#project-context) for registration commands.

## In-app updates

The [first public release (v0.1.0)](https://github.com/vantoan19/ticketd/releases/tag/v0.1.0)
includes the desktop updater and matching CLI.

By default, the desktop checks for updates about ten seconds after launch and
every 24 hours while it is open. It downloads and verifies a newer stable release
in the background. Choose **What's new** to open the release notes, or
**Restart to update** and then **Restart now** to install it. You can return to
**Settings → About** to restart after dismissing the status-line notice. On
macOS and Windows, quitting with a verified update ready installs it for the
next launch. On Linux, choose **Restart to update** to install it.

The restart prompt shows any running Chats and Automation runs that will stop.
Interrupted Automation runs are marked as needing attention when ticketd reopens.
If the release raises the Workspace format version, the prompt warns you before
installing, and quitting doesn't install it: choose **Restart to update** when
you're ready. ticketd makes a backup before migrating the Workspace. Update any
older copies that need to open the migrated Workspace, including other Sync
devices and standalone CLI installations.

On Ubuntu, the update uses the system administrator prompt. If `pkexec` or
`dpkg` is unavailable, choose **Download .deb** to open the release and install
the package manually. If a download or signature check fails, About offers
**Try again** and a link to the release.

To stop scheduled checks, turn off **Check for updates automatically** in
**Settings → About**. Turning it off also cancels any check or download in
progress. Use **Check for updates** in About to check once. Builds without
an updater public key skip checks and show this in About.

The check makes an unauthenticated HTTPS request to GitHub for the latest release
manifest. It sends standard request headers, including the updater's user agent,
without account credentials, the installed ticketd version or any Workspace data.
GitHub receives usual connection information such as your IP address. Update
checks run in the desktop app only.

## Upgrades and removal

Use desktop and CLI from the same version. Run `ticketd workspace` to inspect the
path and supported format without changing data. Most other workspace commands
may create or migrate the database. Back up before upgrading; an older binary
may refuse a newer workspace, and downgrade compatibility is not guaranteed.
Close both desktop and CLI processes before replacing binaries or restoring a backup.
See [Back up and restore your workspace](workspace-tasks.md#back-up-and-restore-your-workspace).

Uninstall the desktop through the OS or package manager. On macOS, remove the
CLI link if you installed it. On Windows, remove the app folder's entry from your
user PATH if you added it through Settings. On Ubuntu, removing the package also
removes its CLI. Remove any standalone CLI executable separately. The workspace
is stored separately in the user's application-data directory and is retained.
Keep a backup before uninstalling or upgrading.

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

To keep the same workspace on two computers, follow [Sync two desktops with Google Drive](workspace-tasks.md#sync-two-desktops-with-google-drive).

### Publisher and developer configuration

For source and distribution builds, see [Configure Google Drive for a build](releasing.md#configure-google-drive-for-a-build).
