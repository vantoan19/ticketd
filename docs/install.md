# Install ticketd

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
Registered project paths belong to the native OS environment; see the repository
README for project context commands.

Uninstall the desktop through the OS or package manager and remove the copied
CLI executable. The workspace is stored separately in the user's application-data
directory and is retained. Keep a backup before uninstalling or upgrading.

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
