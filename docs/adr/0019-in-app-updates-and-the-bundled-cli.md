# In-app updates and the bundled CLI

## Decision

The desktop finds, downloads and installs new releases itself, through Tauri's
updater (`tauri-plugin-updater`). The `ticketd` CLI ships inside the app and is
updated with it. The CLI never contacts the network on its own.

- **What is offered.** Only a published, non-prerelease GitHub Release. The updater
  reads a static `latest.json` attached to each release, through
  `releases/latest/download/latest.json`, which GitHub resolves to the newest
  published non-prerelease. The manifest includes the release's Workspace
  format version. A draft, which is how every release is tested
  ([release model](../releasing.md#release-model)), or a `-beta` prerelease is never
  offered.
- **Trust.** Each update file is signed with a minisign key that is separate from OS
  code signing; the updater refuses a file whose signature does not match the public
  key built into the app or whose signed version differs from the manifest.
  The maintainer generates the key with a password, keeps it in a password
  manager, and stores it as a GitHub secret for the release workflow.
  Releases stay unsigned previews for the operating systems
  ([#212](https://github.com/vantoan19/ticketd/issues/212)).
- **When it checks.** About 10 seconds after launch, then every 24 hours while the
  app is open, and on demand from **Check for updates** in Settings → About. Checks
  are on by default. The switch in Settings → About disables scheduled checks
  and cancels an in-flight check or download. **Check for updates** remains
  available for a one-time check and download. A check is one anonymous HTTPS
  request to GitHub. It sends nothing that identifies the person or the workspace.
- **What it does.** A newer release is downloaded and verified in the background.
  The status line then shows "ticketd X is ready · Restart to update · What's new";
  What's new opens the release page. Restart to update opens the confirmation
  prompt. ticketd applies the update when the person confirms the restart.
- **Restart.** Before restarting, the prompt names running work ("2 Chats are
  running; restarting stops them"). An Automation run that a restart interrupts is
  marked as needing attention at the next start, as any interrupted run already is.
- **Workspace format.** A release that raises the workspace format (a minor release
  under [versioning](../releasing.md#versioning)) says so in the prompt before
  restarting: older ticketd versions, on other Sync devices or as a standalone CLI,
  will refuse the workspace afterwards. The migration takes its backup as usual
  ([ADR 0014](0014-the-migration-ladder-defines-the-workspace-format.md)).
- **Platforms.** macOS replaces the `.app` from the signed `.app.tar.gz`. Windows
  runs the signed MSI. Linux installs the signed `.deb` through the system's admin
  prompt (`pkexec`); where that is unavailable, the notice links to the release to
  download it by hand.
- **No downgrade.** There is no in-app way back to an older version: an older
  binary can refuse a newer workspace. Problems are fixed forward with a new
  release. A failed download or signature check shows the error and a link to the
  release.
- **The bundled CLI.** The app bundle contains the `ticketd` CLI of the same
  version. **Install command-line tool** in Settings → Command line puts it on PATH:
  on macOS a symlink in `/usr/local/bin` after one administrator prompt, or in
  `~/.local/bin` (with a note to add it to PATH) when the prompt is declined; on
  Linux the `.deb` installs it in `/usr/bin`; on Windows the app's folder is added
  to the user's PATH. If an older standalone `ticketd` comes first on PATH, the
  button says so and offers to remove it. Standalone CLI archives stay on each
  release for machines without the desktop app; they are updated by downloading
  the new archive.

## Rejected

- **Notify only, with a download link.** It works with any package format, but
  every update then becomes a manual reinstall of both the app and the CLI. Tauri's
  updater already installs every format ticketd ships, so a notify-only step would
  be built and then thrown away.
- **A custom update feed or server** (Open Design publishes its own JSON to
  Cloudflare R2). It needs hosting and credentials ticketd does not have; GitHub
  Releases is already where releases live.
- **Automatic restart** (Orca's opt-in mode). A restart stops running Chats and
  Automations, so the person chooses when.
- **A self-updating CLI** (`t3 update`), or the CLI checking for updates. Agents run
  the CLI constantly; network calls and update notices on its output would slow or
  confuse them. Shipping it inside the app keeps the two versions equal, which the
  CLI relies on to open the same workspace.
- **Update channels** (T3's Nightly, Orca's rc and daily). There are no nightlies
  ([release model](../releasing.md#release-model)); an opt-in beta channel can come
  later.
- **Generating the updater key in CI.** A key that exists only as a GitHub secret
  has no backup: losing it leaves every installed copy unable to update.

## Why

The three apps studied (Open Design, T3 Code and Orca, all Electron) check soon
after launch and every few hours, download in the background and install on a
restart the person confirms; none offers a switch in the interface to stop the
checks, which a local-first app should. Orca and Open Design keep their CLI inside
the app bundle so it can never fall behind; T3 Code ships a separate CLI with its
own `update` command. ticketd's desktop already reports a CLI whose version differs
from the app's, because the two must match; bundling removes that failure for
everyone who installs the desktop.

Tauri's updater verifies its own signature and does not check the operating
system's code signature when replacing the app, so ad-hoc-signed macOS builds can
update.

## Offline verification

On macOS 26.5 (arm64), a sandboxed debug build checked a loopback manifest,
rejected tampered update bytes, downloaded and verified a 0.2.0 archive signed
with a throwaway key, and installed it after confirmation. The replaced
ad-hoc-signed bundle passed `codesign --verify --deep --strict`. It had no
`com.apple.quarantine` attribute and relaunched through LaunchServices without
a Gatekeeper prompt. The test used a local feed, so it covers the updater's
replacement of an installed bundle. Opening a downloaded release installer is
a separate Gatekeeper path.

The HTTP log showed no requests after relaunch with automatic checks disabled
and an update available. A manual check still worked. A manifest with a higher
format version showed the restart warning. After restart the existing ticket
was readable and a seeded Running Automation run was marked as Needs attention.
The loopback endpoint override was present in the debug binary and absent
from the release-profile binary.

The MSI install and relaunch path still needs a native Windows run.

## Consequences

- Every release carries the updater files (`.app.tar.gz`, the installers' `.sig`
  files) and `latest.json`, produced by the release workflow with the updater key
  ([#537](https://github.com/vantoan19/ticketd/issues/537)).
- Losing the updater key, or its password, means no installed copy can update in
  place again; people would have to reinstall by hand. The key is backed up outside
  GitHub.
- v0.1.0 was built before the updater existed and cannot update itself; its users
  download the next release once.
- `docs/install.md` and `docs/releasing.md` change when this ships: in-app updates,
  the bundled CLI, and Install command-line tool.
- The bundled CLI's PATH link on macOS points into `/Applications/ticketd.app`, so
  moving the app breaks the link until the button is used again.
