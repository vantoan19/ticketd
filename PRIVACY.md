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
or automatic crash-report uploads to ticketd maintainers. Update checks and the
integrations you turn on make the requests below.

The desktop keeps a local log of what the app did, to find out why something went
wrong afterwards. It is a set of JSON files in your OS's log folder (on macOS,
`~/Library/Logs/com.vantoan19.ticketd/`), one per day. ticketd keeps the last 7 days
and at most 50 MB, and deletes older files when it starts. A line holds the time, a
level, the part of ticketd that wrote it, a short message, and IDs, counts, durations
and error kinds. By design, it never holds the text of your tickets, Documents, Plans
or Chats. Error messages from your operating system can still contain a file path.
The files never leave your machine by themselves; sharing them is your choice. The
CLI writes its own warnings and errors to your terminal. Both the desktop and CLI
keep bounded, rotated stderr logs for each source connection. ticketd redacts known
credential values before writing them. Extensions can still write private content
to these local files.

Settings → Diagnostics can export those logs for a bug report: a `.zip` of under 5 MB
with a summary (app, OS and WebView versions, log level, whether sync is on, Harness
versions), the Workspace's health (Format version, a SQLite integrity check, file
sizes, and the number of rows in each table), the kinds of warning and error with how
often they happened, and the last 3 days of logs. Each log line is rebuilt from a short
list of fields, so any other field is dropped, and your home folder, OS username,
Workspace path and Drive account email are replaced wherever they appear. IDs are kept.
Each recent source connection log is represented by its line count. The ZIP omits
extension stderr text.
Nothing is uploaded: ticketd saves the file where you choose, and anything you attach to
a public GitHub issue can be read by anyone.

Workspace files and exports are not encrypted by ticketd. Protect them with OS
permissions, disk encryption, and appropriate backup storage. Anyone who can read
these files may be able to read their content.

## Workspace sync

Workspace sync is optional and off until you connect Google Drive for it. While
it is on, ticketd stores a copy of your Workspace content in a visible folder it
creates in your own Google Drive: one Markdown file for every ticket (with its
authored Activities and Implementation evidence), Document, Plan and project,
including tags, relationships, follows, reminders and external-source provenance,
plus your managed Attachment files.

The folder also holds the name of each desktop you sync from. The name is your
computer's name unless you change it in the sync settings, and it is written to
the folder's device list and into each file that desktop uploads.

**These files are not encrypted by ticketd.** They are readable in Drive by you,
by anyone you share the folder with, and by anyone or anything with access to
your Google account. There is no sync password. Google stores them under its own
terms, and Drive keeps its own revisions of changed files. ticketd has no server
and receives none of this content.

Sync uses the same per-file `drive.file` access as attachments. ticketd can reach
only files it created or you selected for it, not the rest of your Drive.

The following never leave the device through sync: Attention inbox read state,
project checkout paths, credentials, source connection settings, window layout,
unfinished drafts, upload queues, and the 30-day local version history.

## When data leaves your machine

| Action                                                    | Destination and data                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connect or refresh a GitHub source                        | GitHub or the configured GitHub Enterprise API receives authenticated requests for the configured source; downloaded issue data is cached locally. Configured sources may refresh in the background.                                                                                                                                                                                                           |
| Publish a ticket to a source                              | The selected provider receives the content included in the publication. Review the preview and destination before publishing.                                                                                                                                                                                                                                                                                  |
| Sign in to Google Drive or select a file                  | Google's sign-in and Picker services receive the authorization requests. ticketd requests per-file `drive.file` access and stores selected-file identity and metadata locally.                                                                                                                                                                                                                                 |
| Upload or retrieve a Drive attachment                     | Google receives the selected upload bytes and metadata, or serves the requested download. These operations need network access.                                                                                                                                                                                                                                                                                |
| Use Workspace sync                                        | Google Drive receives your synced Workspace content and managed Attachment files, unencrypted, in a folder in your own Drive. See [Workspace sync](#workspace-sync).                                                                                                                                                                                                                                           |
| Check for updates                                         | The desktop makes an anonymous GitHub Releases request on launch, daily while open, and on demand. It downloads and verifies a newer release in the background. GitHub sees the connecting IP address (or your proxy's), as with any web request, and which release and platform file is downloaded; no account, installed version or workspace data is sent. Turn off scheduled requests in Settings → About. |
| Open an external link                                     | Your browser or OS handler opens the destination under its own privacy settings.                                                                                                                                                                                                                                                                                                                               |
| Share an export, backup, screenshot, or diagnostic report | The recipient receives whatever you include; ticketd does not redact authored ticket content from a workspace backup or export.                                                                                                                                                                                                                                                                                |

An external agent that invokes the CLI can read the command's output and may send
it to its model provider. Configure that agent according to your data requirements.
Installing ticketd's discovery skill does not itself create a model-provider account.

## Credentials

The GitHub connector reuses environment credentials or the GitHub CLI's existing
authentication. It does not persist those tokens in the ticket workspace or export.
See the [credential lookup implementation](https://github.com/vantoan19/ticketd/blob/main/crates/ticketd-core/src/source/github/credentials.rs)
for host-specific environment-variable precedence.

Google authorization uses the OS secure store: Windows Credential Manager,
macOS Keychain, or Linux Secret Service. There is no file-based credential fallback.
The Google desktop app registration bundled by a publisher is separate from a user's
access and refresh tokens. See [Google Drive setup](https://github.com/vantoan19/ticketd/blob/main/docs/install.md#google-drive-setup).

## Google user data

When you connect Google Drive, ticketd asks Google for one permission, the
per-file `drive.file` scope. With it, ticketd can see and change only the Drive
files it created for you and the files you select in Google's Picker. It cannot
list or read the rest of your Drive.

ticketd uses that access for two features you turn on yourself: Drive attachments
and Workspace sync. It reads your Drive account's email address and permission ID
to show which account is connected and to keep each grant tied to that account.
It reads the names, sizes, checksums and versions of authorized files, and
uploads or downloads their bytes when you attach, sync, retrieve or export them.

Your Google access and refresh tokens stay in your OS secure store. File details
and the account email stay in your local Workspace. A backup you save copies them
too, and a JSON export includes the last-known Drive file details. ticketd has no server and
sends none of this to its maintainers or to third parties. It does not sell this
data, use it for advertising, or use it to train AI models. An agent you run
yourself can read what the CLI prints, as described above. Revoke access at any time in your
[Google Account's third-party connections](https://myaccount.google.com/connections).
Then remove the local data as described below.

ticketd's use and transfer to any other app of information received from Google
APIs will adhere to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements.

## Retention, backups, and removal

Trashing an item is reversible and does not immediately erase all its data. Local
attachment cleanup, quarantine, and purge have distinct effects; review their
confirmation messages. Removing a remote attachment from ticketd does not delete
the corresponding Google Drive file.

Workspace sync never deletes a record: an item you trash keeps its file in Drive,
marked as in Trash. Turning sync off on a desktop removes nothing from that desktop or
from Drive. Deleting a single synced file in Drive does not remove it: the next
sync run of a connected desktop uploads it again. Sync stops only when the whole
folder is removed or the desktop is disconnected. To remove synced content from
Google, disconnect your desktops and delete the folder in Drive yourself; Drive's
own trash and revision retention then apply.

Uninstalling the desktop leaves workspace data behind. Backups and exports also
remain wherever you saved them. A backup retains local workspace data and local
attachment bytes, but not Google credentials or remote attachment bytes. Restoring
it does not restore remote authorization. See [export and backup behavior](https://github.com/vantoan19/ticketd/blob/main/docs/export.md).

For complete removal, close ticketd and other processes using the workspace,
identify its location before deleting data, and account for separately saved backups,
exports, WebView data, OS credentials, and any remote copies. Keep a backup if you
may need recovery. Revoking access at a provider does not erase previously exported files.

## Reporting problems

Use minimal synthetic examples in public reports. Remove tokens, authorization
URLs, private ticket content, personal paths, and account identifiers from diagnostics.
Do not attach your normal workspace database or backup. Follow [SECURITY.md](https://github.com/vantoan19/ticketd/blob/main/SECURITY.md)
for suspected vulnerabilities.
