# Release and distribution

Releases are maintainer-managed. This guide describes the versioning and release
model, the existing artifact build, and the checks a public release needs; it does
not claim those checks have already been passed.

## Current build workflow

One reusable workflow, [Distribution](../.github/workflows/distribution.yml), builds
the CLI and bundles that executable in the desktop installer for macOS Apple Silicon,
Ubuntu 24.04 x86-64, and Windows x86-64. It builds the exact main commit its caller
passes and uploads one artifact per platform, named `ticketd-<platform>-<short SHA>`.
Three workflows call it:

- [Release](../.github/workflows/release.yml) runs when Quality succeeds on a push
  to `main`. It builds that commit and keeps the packages for 14 days. When the
  commit's version has no release yet, it also creates the draft release (see
  the [release model](#release-model)). Run it by hand to draft again after
  deleting a draft, or for a [dry run](#dry-run-a-release).
- The manual [Package workflow](../.github/workflows/package.yml) builds the current
  `main` with seven-day retention. Its `linux-distribution` target builds only
  Linux, and `native-smoke` runs the Linux native desktop smoke test on any branch.
- [Version bump](../.github/workflows/version-bump.yml) builds nothing. It opens
  the PR that starts a release.

The scripts behind them are tested by `./scripts/check fast`. `release-plan.mjs`
decides whether a commit is drafted. `release-version.mjs` checks and sets versions.
`assemble-release.mjs` builds the release files and `SHA256SUMS`, and
`release-notes.mjs` writes the notes. OS code signing is a separate step.

Distribution CI embeds one Google desktop app registration across the supported platforms.
See [Configure Google Drive for a build](#configure-google-drive-for-a-build).
An independent local build can omit Google configuration and keep Drive disabled;
see [development packaging](development.md#build-packages).

### Updater signing

Generate the Tauri updater key once and choose a strong password when prompted.

```sh
npm run desktop -- signer generate -w ~/.tauri/ticketd-updater.key
```

Keep a backup of the private key and its password together in the maintainer's
password manager outside GitHub. Keep the private key out of Git. If the key or
password is lost, affected installations need a manual reinstall. Those copies
trust only the public key they shipped with.

Set the GitHub Actions repository variable `TAURI_UPDATER_PUBLIC_KEY` to the
contents of `ticketd-updater.key.pub`. Set `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as repository secrets. The distribution build
embeds the public key and signs the macOS app archive (`.app.tar.gz`), Debian
package (`.deb`), and Windows installer (`.msi`). Updater signatures are separate
from OS code signing. If an input is missing, the workflow warns and builds
packages without updater signatures.

The Release workflow assembles the updater files. It renames the macOS
`ticketd.app.tar.gz` to `ticketd_<version>_aarch64.app.tar.gz`, keeping its
signature, since a signature covers the bytes and not the name. It then runs the
build commit's manifest generator, which writes `latest.json` with the release
version, Workspace format version, and each platform's download URL and signature.
A release draft requires all three signed updater files.

If the workflow cannot run, assemble a draft by hand from a Package run instead.
Download the three artifacts with `gh run download <run id> --dir downloads`,
check out the commit that built them, and run the assembly script. It writes exactly the files a draft attaches,
including `latest.json` and `SHA256SUMS`.

```sh
node scripts/assemble-release.mjs --version 0.2.0 --artifacts downloads \
  --source . --out release-assets
```

Then create the draft with `gh release create v0.2.0 release-assets/* --draft --target <sha>`.
A hand-assembled draft has no build attestations.

## Configure Google Drive for a build

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

## Repository CI settings

All jobs use standard GitHub-hosted runners. Keep repository-level self-hosted
runner registrations empty and, if the repository moves into an organization,
exclude it from self-hosted runner groups. A workflow condition alone cannot
protect a registered runner from a PR that changes the workflow.

Keep the default workflow token read-only, with permission to approve pull
requests disabled. That setting also stops the workflow token from opening the
version-bump PR, so Version bump then leaves a prefilled link to open it by hand.
Use `pull_request` for contribution checks; privileged workflows must not check
out or execute unreviewed PR content. Distribution credentials belong only in the
Distribution workflow, which builds only `main` commits:

- Package runs it only when dispatched on `main`.
- Release runs it for a `workflow_run` only when Quality succeeded for a `push` to
  this repository's `main`. A dispatch must be on `main` and names a commit that
  is on `main` and passed Quality.
- The job that writes the draft release has `contents: write`, `id-token: write`
  and `attestations: write`. It reads no build secrets and runs only this
  repository's scripts on the downloaded packages. The Version bump job can push
  a `release/` branch, label and open its PR, and reads no secrets. Every other
  job has read-only permissions.

At public launch, configure and verify these settings:

- Require workflow approval for all outside collaborators. This is an execution
  gate, not a substitute for runner isolation or code review.
- Protect `main` with pull requests and the required `CI result` check from
  GitHub Actions; require the branch to be up to date. Keep force pushes and
  branch deletion disabled. `CI result` covers the Linux, macOS and Windows jobs,
  so no other check needs to be required.
- Verify a harmless PR from an outside fork: approval is required, Linux runs
  on a GitHub-hosted runner, distribution is skipped, and the required check
  reports against the PR before merge.

GitHub may reject fork-approval or protection configuration while this repository
is private on its current plan. Record those pending checks locally in ticketd
and apply them when public visibility makes them available. Keep the visibility
change distinct from signed-release publication.

## Versioning

ticketd uses [Semantic Versioning](https://semver.org/) and stays on `0.x` until 1.0.
The desktop app and the CLI always share one version; `node scripts/check-versions.mjs`
keeps `Cargo.toml`, both `package.json` files and `tauri.conf.json` equal. Tags are
`v<version>`, for example `v0.2.0`.

Before 1.0:

- **Minor** (0.**2**.0): a breaking CLI change (a removed or renamed command or flag,
  or changed output that scripts or agents read), or a workspace format change that
  older binaries cannot open.
- **Patch** (0.1.**1**): everything else, including new features that break nothing.

The workspace format has its own number, separate from the app version. A release
that raises it is a minor release and says so in its notes.

1.0 means the CLI output and the workspace format are stable enough to promise
compatibility, distributions are signed, and the core features (Tickets, Documents,
Plans, the CLI and Sync) have proven stable in real use.

## Release model

Build continuously, publish deliberately. There are no nightlies or update channels.

1. Every green `main` commit builds the desktop and CLI packages for each platform as
   workflow downloads kept for 14 days, in its Release workflow run. They are for
   trying `main`, not releases.
2. A release starts with a version-bump PR. Run the **Version bump** workflow with the
   version, for example `0.2.0`. It refuses a version that is not SemVer or not newer
   than every published release. It sets the version in `Cargo.toml`, the
   `package.json` files and `tauri.conf.json`, and changes only the workspace's own
   entries in `Cargo.lock` and `package-lock.json`. Then it pushes `release/v<version>`
   and opens a PR labeled `release` with the drafted release notes.
   - A PR opened with the workflow token does not start CI. Close the PR and reopen
     it, which runs Quality. If the token may not open PRs (see
     [repository CI settings](#repository-ci-settings)), open it from the link in the
     run summary instead; a PR you open runs CI as usual.
   - Edit the notes between the PR's `release-notes` markers.
   - Merge once `CI result` passes.
3. When `CI result` passes on the merge commit, the Release workflow builds that exact
   commit into a **draft** GitHub Release `v<version>` targeting it. A draft is visible
   only to maintainers, and its tag is created only when it is published. The draft
   has 15 files:
   - the three desktop installers (`.dmg`, `.deb`, `.msi`);
   - the standalone CLI archives;
   - the signed updater files with their `.sig` files, and `latest.json`
     (see [updater signing](#updater-signing));
   - `LICENSE`, `THIRD_PARTY_NOTICES.md` and `INSTALL.md` from the build commit;
   - `SHA256SUMS` over all of them.

   Every file has a build-provenance attestation. The notes are the PR's hand-written
   section, then GitHub's generated notes, grouped by the labels in
   [`.github/release.yml`](../.github/release.yml).

4. The maintainer tests the draft's own files (see the checklist below).
5. **Publish** makes those same files public as Latest. Installed desktop copies
   with the updater then find the newer release through
   `releases/latest/download/latest.json`. Drafts and prereleases stay outside
   this feed.
6. If testing fails, delete the draft and fix `main`. The next green `main` commit
   builds the same version into a new draft. To rebuild sooner, run the Release
   workflow by hand. Nothing was public, so no version number is spent. Record why
   in the local ticketd release plan.
7. A problem found after publishing is fixed forward with a patch release. Never
   replace the files of a published release; add a known-issue note to it instead.

The Release workflow never deletes or changes a release. It drafts nothing for a
version that is published, not newer than the latest release, or already has a
draft; a manual run fails instead. To rebuild a draft, delete it on the Releases
page, then run the Release workflow again. The workflow cannot delete drafts
itself: GitHub's delete call cannot be limited to drafts, so a draft published
between a check and the delete would be lost.

Release whenever `main` has user-visible changes, aiming for small releases every one
to two weeks. A public beta (`v0.3.0-beta.1`, published as a prerelease) is optional,
for a risky release such as a large workspace format change.

If the workflows cannot run, fall back to the manual steps. Bump the version with
`node scripts/release-version.mjs set <version>` in a PR. After it merges, run the
Package workflow while that commit is the head of `main`, then
[assemble the draft by hand](#updater-signing).

## Dry run a release

A dry run builds a draft with a test version from a `main` commit without changing
`main`. The version override is patched into each build's checkout and never
committed, so the packages, `latest.json` and the draft all carry the test version.

1. Run the Release workflow on `main` with `version_override` set to a prerelease
   such as `0.1.1-dryrun.1`. Leave `sha` empty to build the latest green `main`
   commit.
2. Download the draft's files and check them:
   - `gh release download v0.1.1-dryrun.1 --dir dryrun`, then
     `shasum -a 256 -c SHA256SUMS` in that directory;
   - `gh attestation verify <file> --repo vantoan19/ticketd` for each file;
   - `latest.json` names the test version and the draft's file URLs.
3. Delete the draft with `gh release delete v0.1.1-dryrun.1 --yes`. A draft has no
   tag to clean up.
4. Run the Release workflow again with `version_override` set to a published
   version, such as `0.1.0`. It fails in its Plan job and leaves that release
   unchanged.

A prerelease draft is marked as a prerelease, so publishing it by mistake does not
make it the latest release or offer it as an update. Its MSI carries the release's
numeric version (`0.1.1`), because Windows Installer versions are numeric.

## Test a draft release

Test the draft's own files, not a local build:

1. Install the desktop app from the draft on each advertised platform. Verify
   that its bundled CLI is available through **Settings → Command line** on macOS
   and Windows and installed in `/usr/bin` by the Debian package. Check separately
   that the standalone CLI archives run. Use a separate OS user for release-desktop
   tests. The workspace override is available in debug builds only.
2. Check startup, a small desktop and CLI shared-workspace operation, backup and
   restore, the upgrade from the previous release, and uninstall retention, with
   synthetic data. A release that changes the workspace format also needs an upgrade
   of a workspace made by the previous release.
3. If advertising Drive support, complete the configured-account and secure-store
   checks in [Drive verification](testing-google-drive.md). Fixture tests do not
   establish live authorization or packaged-app behavior.
4. Verify the ticketd icon in each packaged application and installer. Its source
   is `apps/desktop/src-tauri/app-icon.svg`. To regenerate icons, run
   `npm run desktop -- icon src-tauri/app-icon.svg` from the repository root;
   retain the desktop outputs in `apps/desktop/src-tauri/icons/`.
5. Verify the root license and all required third-party license texts accompany
   the distributed files. Use [the attribution index](../THIRD_PARTY_NOTICES.md)
   as a starting point, then review the actual dependency and asset contents of
   each platform artifact. The current workflow does not assemble a complete
   third-party notice bundle.
6. Check that the checksums match the downloaded files
   (`shasum -a 256 -c SHA256SUMS`), and verify each file's attestation with
   `gh attestation verify <file> --repo vantoan19/ticketd`.

## Publish a public release

Before the first public release, verify the MIT license and third-party notices,
private reporting routes, public-PR runner safety, repository-history review, and
repository access/protection settings. Enable GitHub private vulnerability
reporting and verify the reporting form from outside the maintainer account. The
email route in `SECURITY.md` remains available.

Releases are **unsigned preview builds** until signing is set up; see
[#534](https://github.com/vantoan19/ticketd/issues/534) for how comparable projects
handle signing. Release notes and the install guide must say so and explain the
platform warnings: on macOS, remove the quarantine attribute
(`/usr/bin/xattr -d com.apple.quarantine`) or use System Settings → Privacy & Security →
Open Anyway; on Windows, SmartScreen's More info → Run anyway.

For OS signing requirements, see the [Tauri macOS signing guide](https://v2.tauri.app/distribute/sign/macos/) and [Windows signing guide](https://v2.tauri.app/distribute/sign/windows/).

A release contains the matching desktop and CLI, installation instructions, license
notices, SHA-256 checksums, and the updater files described in the
[release model](#release-model). Release notes are GitHub's generated notes, grouped
by PR label, plus a short hand-written section covering the following.

- Tested platforms and known limitations.
- Signing status and required external-service setup.
- Data-format or CLI compatibility changes, backup needs, and downgrade limitations.

After publishing, verify the download links and hashes. Once a previous release
has the updater enabled, use it to confirm the new release appears in
**Settings → About**. Point users to GitHub Releases for stable downloads.

## Compatibility and maintenance

Publish desktop and CLI from the same version. Most workspace commands can migrate
data when opening it; older binaries may refuse a newer format. Do not promise
downgrade support without testing it against that release's migrations.

Organize release tasks locally in ticketd. Summarize release evidence on the
relevant PR and report distinct user-facing bugs in GitHub Issues. Announce a support window only when maintainers
have committed to it. Update installation and security guidance when that policy changes.
