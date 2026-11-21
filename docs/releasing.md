# Release and distribution

Releases are maintainer-managed. This guide describes the versioning and release
model, the existing artifact build, and the checks a public release needs; it does
not claim those checks have already been passed.

## Current build workflow

The manual [Package workflow](../.github/workflows/package.yml) builds the
standalone CLI and desktop installer for macOS Apple Silicon, Ubuntu 24.04 x86-64,
and Windows x86-64, and runs only on `main`. Its `linux-distribution` target limits
the build to Linux, and `native-smoke` runs the Linux native desktop smoke test.
The workflow uploads artifacts with seven-day retention. GitHub Release creation
and OS code signing are separate steps.

Distribution CI requires a platform-specific Google desktop app registration;
see [publisher configuration](install.md#publisher-and-developer-configuration).
An independent local build can omit Google configuration and keep Drive disabled;
see [development packaging](development.md#build-packages).

### Updater signing

Generate the Tauri updater key once and choose a strong password when prompted.

```sh
npm run desktop -- signer generate -w ~/.tauri/ticketd-updater.key
```

Back up the private key and its password in the maintainer's password manager.
Set the GitHub Actions repository variable `TAURI_UPDATER_PUBLIC_KEY` to the
contents of `ticketd-updater.key.pub`. Set `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as repository secrets. The distribution build
embeds the public key and signs the macOS app archive, Debian package and Windows
MSI. If any of the three inputs is missing, it warns and builds installers alone.

To assemble the updater manifest, stage the release assets under their final
upload names in one directory, then run the manifest generator.

```sh
node scripts/generate-latest.mjs 0.2.0 "$(date -u +%Y-%m-%dT%H:%M:%SZ)" release-assets
```

The script writes `latest.json` into that directory when all three updater files
have signatures. It warns and skips the manifest for unsigned builds and fails if
only some of the required files are signed. Attach the generated manifest and its
signed assets to the draft together. The app's `releases/latest` endpoint resolves
to a published release.

## Repository CI settings

All jobs use standard GitHub-hosted runners. Keep repository-level self-hosted
runner registrations empty and, if the repository moves into an organization,
exclude it from self-hosted runner groups. A workflow condition alone cannot
protect a registered runner from a PR that changes the workflow.

Keep the default workflow token read-only, with permission to approve pull
requests disabled. Use `pull_request` for contribution checks; privileged
workflows must not check out or execute unreviewed PR content. Distribution
credentials belong only in the manual `main` build path.

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
is private on its current plan. Record those pending checks in the launch issue
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
   workflow downloads kept for 14 days. They are for trying `main`, not releases.
2. A release starts with a version-bump PR: the maintainer picks the version, the PR
   changes the version files and drafts the release notes, and it merges once
   `CI result` passes.
3. The merged commit is built into a **draft** GitHub Release: the final-version
   packages, SHA-256 checksums and build attestations. A draft is visible only to
   maintainers, and its tag is created only when it is published.
4. The maintainer tests the draft's own files (see the checklist below).
5. **Publish** makes exactly those files public as Latest. Nothing is rebuilt.
6. If testing fails, delete the draft, fix `main` and build the same version again.
   Nothing was public, so no version number is spent. Record why in the release's
   tracking issue.
7. A problem found after publishing is fixed forward with a patch release. Never
   replace the files of a published release; add a known-issue note to it instead.

Release whenever `main` has user-visible changes, aiming for small releases every one
to two weeks. A public beta (`v0.3.0-beta.1`, published as a prerelease) is optional,
for a risky release such as a large workspace format change.

Steps 1 to 3 are not automated yet ([#212](https://github.com/vantoan19/ticketd/issues/212)).
Until they are, bump the versions by hand, run the manual Package workflow on the
merged commit, and create the draft release from its downloads.

## Test a draft release

Test the draft's own files, not a local build:

1. Install the desktop app and the CLI from the draft on each advertised platform.
   Use a separate OS user for release-desktop tests: the debug workspace override
   does not apply to release desktop builds.
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
6. Check that the checksums match the downloaded files.

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
(`xattr -d com.apple.quarantine`) or use System Settings → Privacy & Security →
Open Anyway; on Windows, SmartScreen's More info → Run anyway.

A release contains the matching desktop and CLI, installation instructions, license
notices, and SHA-256 checksums. Release notes are GitHub's generated notes, grouped
by PR label, plus a short hand-written section that states:

- Tested platforms and known limitations.
- Signing status and required external-service setup.
- Data-format or CLI compatibility changes, backup needs, and downgrade limitations.

Verify download links and hashes after publishing. Do not describe expiring workflow
downloads as stable downloads.

## Compatibility and maintenance

Publish desktop and CLI from the same version. Most workspace commands can migrate
data when opening it; older binaries may refuse a newer format. Do not promise
downgrade support without testing it against that release's migrations.

Keep release evidence and follow-up work in GitHub Issues, and durable behavior
documentation in this repository. Announce a support window only when maintainers
have committed to it. Update installation and security guidance when that policy changes.
