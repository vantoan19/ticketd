# Privacy and local data

This document describes the desktop and CLI in this repository. Connected services,
your browser, operating system, and any agent you run have their own data handling.

## What stays on your machine

ticketd stores tickets, Documents, Plans, Activities, project checkout paths,
external-source metadata, and personal state in a local SQLite workspace. Local
attachment copies and retained draft data also live on your machine. Desktop
preferences and legacy drafts may exist in the WebView's local storage.

Run `ticketd workspace` to inspect the database path without creating or migrating
it. Desktop Settings also shows workspace information. Desktop and CLI share the
workspace when run under the same OS user and environment.

The current application does not implement product analytics, session replay,
or automatic crash-report uploads to ticketd maintainers. This is not a promise
that every action is offline: the integrations below make network requests.

Workspace files and exports are not encrypted by ticketd. Protect them with OS
permissions, disk encryption, and appropriate backup storage. Anyone who can read
these files may be able to read their content.

## When data leaves your machine

| Action                                                    | Destination and data                                                                                                                                                                                 |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connect or refresh a GitHub source                        | GitHub or the configured GitHub Enterprise API receives authenticated requests for the configured source; downloaded issue data is cached locally. Configured sources may refresh in the background. |
| Publish a ticket to a source                              | The selected provider receives the content included in the publication. Review the preview and destination before publishing.                                                                        |
| Sign in to Google Drive or select a file                  | Google's sign-in and Picker services receive the authorization requests. ticketd requests per-file `drive.file` access and stores selected-file identity and metadata locally.                       |
| Upload or retrieve a Drive attachment                     | Google receives the selected upload bytes and metadata, or serves the requested download. These operations need network access.                                                                      |
| Open an external link                                     | Your browser or OS handler opens the destination under its own privacy settings.                                                                                                                     |
| Share an export, backup, screenshot, or diagnostic report | The recipient receives whatever you include; ticketd does not redact authored ticket content from a workspace backup or export.                                                                      |

An external agent that invokes the CLI can read the command's output and may send
it to its model provider. Configure that agent according to your data requirements.
Installing ticketd's discovery skill does not itself create a model-provider account.

## Credentials

The GitHub connector reuses environment credentials or the GitHub CLI's existing
authentication. It does not persist those tokens in the ticket workspace or export.
See the [credential lookup implementation](crates/ticketd-core/src/source/github/credentials.rs)
for host-specific environment-variable precedence.

Google authorization uses the OS secure store: Windows Credential Manager,
macOS Keychain, or Linux Secret Service. There is no file-based credential fallback.
The Google desktop app registration bundled by a publisher is separate from a user's
access and refresh tokens. See [Google Drive setup](docs/install.md#google-drive-setup).

## Retention, backups, and removal

Trashing an item is reversible and does not immediately erase all its data. Local
attachment cleanup, quarantine, and purge have distinct effects; review their
confirmation messages. Removing a remote attachment from ticketd does not delete
the corresponding Google Drive file.

Uninstalling the desktop leaves workspace data behind. Backups and exports also
remain wherever you saved them. A backup retains local workspace data and local
attachment bytes, but not Google credentials or remote attachment bytes. Restoring
it does not restore remote authorization. See [export and backup behavior](docs/export.md).

For complete removal, close ticketd and other processes using the workspace,
identify its location before deleting data, and account for separately saved backups,
exports, WebView data, OS credentials, and any remote copies. Keep a backup if you
may need recovery. Revoking access at a provider does not erase previously exported files.

## Reporting problems

Use minimal synthetic examples in public reports. Remove tokens, authorization
URLs, private ticket content, personal paths, and account identifiers from diagnostics.
Do not attach your normal workspace database or backup. Follow [SECURITY.md](SECURITY.md)
for suspected vulnerabilities.
