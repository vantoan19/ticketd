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
  /usr/bin/xattr -dr com.apple.quarantine /Applications/ticketd.app
  ```

  Use the full `/usr/bin/xattr` path: Python's `xattr` package (installed with pip,
  pyenv or Homebrew's Python) can come first on PATH, and it rejects `-r`.

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
  `/usr/local/bin`. If you decline, nothing changes; choose **Use ~/.local/bin
  instead** for a link that needs no password, add that directory to PATH and
  open a new terminal. If you move the app, use **Install command-line tool**
  again to repair the link.
- **On Ubuntu**, the `.deb` already installs `ticketd` in `/usr/bin`.
- **On Windows**, ticketd adds the app's folder to your user PATH. Restart terminals
  and agent harnesses so they inherit the change.

If an older, newer or different standalone `ticketd` comes first on PATH,
**Settings → Command line** shows its version and path. Choose **Use this app's
ticketd**: one administrator prompt removes that copy and links this app's
copy. Use **Check again** (or return to the window) to confirm which copy is found.

On machines without the desktop, download the standalone archive for your
platform (`ticketd-cli-*-macos-arm64.tar.gz`, `ticketd-cli-*-linux-x86_64.tar.gz`,
or `ticketd-cli-*-windows-x86_64.zip`). Extract the executable and move it to a
directory on your PATH, such as `~/.local/bin` on macOS and Linux or
`%LOCALAPPDATA%\Programs\ticketd-cli` on Windows. Add the directory to PATH if
needed. On macOS, remove the quarantine attribute from the extracted executable
with `/usr/bin/xattr -d com.apple.quarantine ~/.local/bin/ticketd` (use its actual path).
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
one, or one a newer ticketd wrote, alone. The desktop app does this on its own each time it starts, for every agent that already has a copy ticketd wrote and nobody changed (the marker's hash still matches the file); it never installs into an agent that has no copy yet. A copy edited after installation, or one ticketd did not
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
Drive folder in **Settings > Files**. Users do not need a Google Cloud project,
a configuration file, or environment variables. Local attachments also work
without signing in. A source build without a registration keeps Drive disabled
and explains that a build with Drive enabled is needed.

Use an unlocked OS-user secure store: Windows Credential Manager, macOS Keychain,
or a running Secret Service session on Linux. Desktop and CLI must run as the same
OS user to share authorization. An unavailable store produces recovery guidance;
there is no file-based credential fallback. Restoring a backup on another machine
restores reference metadata, not credentials or remote bytes; select files again
with the appropriate account. A developer's own Google app registration that is
still in External Testing gets refresh tokens that expire after seven days, so
reconnect weekly with such a build.

To keep the same workspace on two computers, follow [Sync two desktops with Google Drive](workspace-tasks.md#sync-two-desktops-with-google-drive).

### Publisher and developer configuration

For source and distribution builds, see [Configure Google Drive for a build](releasing.md#configure-google-drive-for-a-build).

## S3 sync setup

Workspace sync can keep its folder in an S3 bucket instead of Google Drive
([ADR 0018](adr/0018-s3-sync-storage-signed-in-through-the-aws-cli.md)). ticketd
signs in through the AWS CLI you already use and stores no AWS secret.

What you need:

- **AWS CLI v2, version 2.13 or later**, on each desktop. ticketd looks in
  `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin` and `/usr/local/aws-cli`, because
  an app opened from Finder does not get your shell's `PATH`. If yours is somewhere
  else (installed with pipx or conda, say), choose it with **Choose the aws program…**
  when setup says the CLI isn't installed; ticketd remembers the choice on that desktop.
- **A profile.** Create one in a terminal with `aws configure sso` (IAM Identity
  Center) or `aws configure` (access keys). Assumed roles, MFA and credential helpers
  such as aws-vault work unchanged, and each desktop picks its own profile, under any
  name, so long as it reaches the same bucket.
- **A bucket with Versioning turned on.** Create it yourself; ticketd does not create
  buckets or change their settings. Use a general purpose bucket: S3 directory buckets
  have no Versioning.

In **Settings > Workspace sync**, choose **S3**, pick the profile, and choose **Sign
in** if the profile needs it. Then choose the bucket (a list when the profile may list
buckets, otherwise type its name) and a prefix (`ticketd/` by default). Before the
first sync, ticketd checks the bucket and refuses one that cannot sync safely, saying
what to fix: Versioning off or suspended, a bucket that does not refuse a second
create with `If-None-Match: *`, a missing permission (named where S3 names it), a KMS
key the profile cannot use, or a bucket that does not exist. The check leaves one small
object, `.ticketd-bucket-check`, under the prefix, because sync never deletes. After it
passes, the Upload, Download and Reconnect choices work as with Google Drive.

An S3-compatible service works when it supports Versioning, conditional writes
(`If-None-Match` and `If-Match`) and SHA-256 checksums. Its endpoint comes from the
profile's `endpoint_url`, and must be `https` unless the service runs on this computer
(`localhost`). Setup checks that the profile's credentials can be exported rather than asking
AWS who it is, since AWS knows nothing of a MinIO account. A profile with a `services` section (a service-specific `s3` endpoint)
needs AWS CLI 2.34.22 or later to be read; older CLIs ask you to update. AWS S3, MinIO and Ceph RGW 20.x are
confirmed. Cloudflare R2 (no Versioning) and the Google Cloud Storage XML API (it
ignores the conditional headers) do not work. The bucket check, not this list, decides
for any other service. A Workspace stays with the service its bucket was connected
through: if you edit the profile to reach another endpoint, sync stops with a message.
To move the bucket on purpose, Disconnect in Settings > Workspace sync, then connect again.

### IAM permissions

Give the profile no more than this. Replace `my-bucket` and the `ticketd/` prefix:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:ListBucketVersions",
        "s3:GetBucketVersioning",
        "s3:ListBucketMultipartUploads"
      ],
      "Resource": "arn:aws:s3:::my-bucket"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:PutObject",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts"
      ],
      "Resource": "arn:aws:s3:::my-bucket/ticketd/*"
    }
  ]
}
```

- `s3:ListAllMyBuckets` is optional. With it, setup offers a list of buckets; without
  it, you type the bucket's name.
- The three multipart permissions (`s3:AbortMultipartUpload`,
  `s3:ListMultipartUploadParts` and `s3:ListBucketMultipartUploads`) are used only for
  Attachments over 16 MiB. The bucket check tries `s3:ListBucketMultipartUploads`, but
  not the other two. Without `s3:ListMultipartUploadParts`, an interrupted upload
  cannot resume. Without `s3:AbortMultipartUpload`, abandoned parts stay in the bucket,
  and are billed, until a lifecycle rule that aborts incomplete multipart uploads
  removes them.
- For a bucket encrypted with a KMS key, also allow `kms:GenerateDataKey` and
  `kms:Decrypt` on that key.

### Lifecycle rule

Sync lists a folder's object versions to find changes, so the cost of a sync run grows
with history, and each version is billed as storage. Add a lifecycle rule that expires
noncurrent versions after more than 30 days. It bounds both without affecting History,
which keeps 30 days of versions on each desktop. For the prefix `ticketd/`:

```json
{
  "Rules": [
    {
      "ID": "ticketd-expire-old-versions",
      "Status": "Enabled",
      "Filter": { "Prefix": "ticketd/" },
      "NoncurrentVersionExpiration": { "NoncurrentDays": 31 }
    }
  ]
}
```

This command replaces the bucket's whole lifecycle configuration, including rules for
other prefixes. If the bucket already has rules, read them first with `aws s3api
get-bucket-lifecycle-configuration --bucket my-bucket`, add this rule to them, and apply
the combined file (or add the rule in the S3 console instead). Then apply it with `aws
s3api put-bucket-lifecycle-configuration --bucket my-bucket --lifecycle-configuration
file://rule.json`. ticketd never sets the rule itself.
