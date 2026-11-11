# Release and distribution

Releases are maintainer-managed. This guide separates the existing artifact build
from the requirements for a public release; it does not claim those requirements
have already been met.

## Current build workflow

The [Quality workflow](../.github/workflows/quality.yml) has a manual `distribution`
input, accepted only on `main`. It builds the standalone CLI and desktop installer for macOS Apple Silicon,
Ubuntu 24.04 x86-64, and Windows x86-64. `linux_only` limits that distribution run
to Linux. The workflow uploads artifacts with seven-day retention. It does not
publish a GitHub Release or configure signing/notarization.

Distribution CI requires a platform-specific Google desktop app registration;
see [publisher configuration](install.md#publisher-and-developer-configuration).
An independent local build can omit Google configuration and keep Drive disabled;
see [development packaging](development.md#build-packages).

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
- Protect `main` with pull requests and the required `Quality checks (Linux)`
  check from GitHub Actions; require the branch to be up to date. Keep force
  pushes and branch deletion disabled. Optional labeled platform jobs are not
  universally required checks.
- Verify a harmless PR from an outside fork: approval is required, Linux runs
  on a GitHub-hosted runner, distribution is skipped, and the required check
  reports against the PR before merge.

GitHub may reject fork-approval or protection configuration while this repository
is private on its current plan. Record those pending checks in the launch issue
and apply them when public visibility makes them available. Keep the visibility
change distinct from signed-release publication.

## Prepare a release candidate

1. Choose a reviewed commit. Update the version together in `Cargo.toml`, the
   root and desktop `package.json`, and `apps/desktop/src-tauri/tauri.conf.json`.
   Refresh affected lockfile metadata without unrelated dependency upgrades.
   Run `node scripts/check-versions.mjs`.
2. Build the frontend, run `./scripts/check`, and verify desktop and CLI builds
   on each advertised platform. Preserve the tested commit and artifact hashes
   in the release evidence. A successful build alone is not installation verification.
3. Exercise installation, startup, desktop/CLI sharing, backup and restore,
   upgrade compatibility, and uninstall retention with synthetic data. Use a
   separate OS user for release-desktop tests: the debug workspace override does
   not apply to release desktop builds.
4. If advertising Drive support, complete the configured-account and secure-store
   checks in [Drive verification](testing-google-drive.md). Fixture tests do not
   establish live authorization or packaged-app behavior.
5. Verify the root license and all required third-party license texts accompany
   the distributed files. Use [the attribution index](../THIRD_PARTY_NOTICES.md)
   as a starting point, then review the actual dependency and asset contents of
   each platform artifact. The current workflow does not assemble a complete
   third-party notice bundle.

## Publish a public release

Before publishing, resolve the license, private reporting routes, public-PR runner
safety, repository-history review, and repository access/protection settings.
These are publication prerequisites, not changes performed by the artifact workflow.

Sign and notarize distributions where applicable, or explicitly identify unsigned
preview builds and their platform limitations. Verify installation with the final
artifacts on the target systems.

Create a versioned GitHub Release attached to the tested commit, and attach durable
downloads containing the matching desktop and CLI, installation instructions,
license notices, and SHA-256 checksums. Release notes should state:

- User-visible changes and fixed problems.
- Tested platforms and known limitations.
- Signing status and required external-service setup.
- Data-format or CLI compatibility changes, backup needs, and downgrade limitations.

Verify download links and hashes after upload. Use the final tested artifacts;
rebuilding after validation requires validating the replacement artifacts.
Do not describe expiring workflow artifacts as stable downloads.

## Compatibility and maintenance

Publish desktop and CLI from the same version. Most workspace commands can migrate
data when opening it; older binaries may refuse a newer format. Do not promise
downgrade support without testing it against that release's migrations.

Keep release evidence and follow-up work in GitHub Issues, and durable behavior
documentation in this repository. Announce a support window only when maintainers
have committed to it. Update installation and security guidance when that policy changes.
