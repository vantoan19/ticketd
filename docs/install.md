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
