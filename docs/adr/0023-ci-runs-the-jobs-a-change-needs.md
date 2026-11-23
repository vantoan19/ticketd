# CI runs the jobs a change needs, split into shards

## Decision

A pull request runs the jobs its change needs, and the slow ones run as shards. The required check stays `CI result`, so branch protection does not change.

- **A change plan decides the jobs.** A `plan` job reads the pull request's merge commit (`fetch-depth: 2`, `git diff --name-only HEAD^1 HEAD`) and `scripts/ci-plan.mjs` maps each changed path to two lanes: **frontend** (the frontend shards) and **Rust** (Clippy, and the Linux, macOS and Windows test shards). The fast checks always run. The path-to-lane table lives in the script and is tested by `scripts/ci-plan.test.mjs`; `scripts/check plan <base>` runs it locally. Everything runs for a push to `main`, the nightly schedule, `workflow_dispatch`, a pull request labeled `ci-full`, a path that matches no rule, an empty diff and any `git` failure. A `git` failure is captured as its own case, so it can never come back as "no changes".
- **A skip passes only when the plan made it optional.** `CI result` passes when the plan job succeeded, every planned job is `success` and every unplanned job is `skipped`. A failed or cancelled job always fails it. A planned job that was skipped fails it, which is what [#526](https://github.com/vantoan19/ticketd/pull/526) needed: a skip must never count as a pass by accident. Its summary lists the jobs the plan asked for and the paths that caused each one, next to the timing table.
- **Each shard compiles its own tests.** The Rust shards share a build cache per OS and each compile what they run, instead of one job building a nextest archive for the others to download.
- **Windows uses the `D:` drive, not ReFS.** `TEMP`, `TMP` and `CARGO_HOME` point at `D:` (the checkout and `target/` are already there). The tests' temporary Workspaces are what made `C:` slow.
- **nextest never retries.** The `ci` profile has `retries = 0`, so a flaky test fails the run and stays visible ([#533](https://github.com/vantoan19/ticketd/issues/533)).
- **webkit gets apt timeouts, not a container image.** The Linux desktop packages are installed only by jobs that compile the desktop crate, with short apt timeouts and retries. A prebuilt container image stays in reserve for the case that stalls continue.

## Rejected

- **A workflow-level `paths:` filter.** GitHub leaves a workflow that a path filter skipped with its checks Pending, which blocks the merge of the required `CI result`. The plan has to live inside the workflow.
- **A third-party paths-filter action.** The table is ours, and a few lines of tested code are easier to review than a pinned action and its own rule syntax.
- **Treating every skip as a pass** (Deno, Vite and Jan do). A job that should have run but was skipped by a bad condition, an event type or a failed dependency would merge unnoticed. [uv's `CONDITIONAL_JOBS`](https://github.com/astral-sh/uv/blob/e773c58f5b1352e882a6b551f90cc36ecbb2b6e3/.github/workflows/ci.yml#L410-L460) is the model: a skip is accepted only when the plan listed that job as optional.
- **A nextest archive shared by the shards.** uv measured it as not faster ([uv #21715](https://github.com/astral-sh/uv/pull/21715)), and it adds an upload and a download to every shard.
- **A ReFS Dev Drive on Windows.** On standard runners it was no faster than `D:`, and ruff found it changes directory-delete events ([ruff #15664](https://github.com/astral-sh/ruff/pull/15664)).
- **Retrying flaky tests to green.** It hides the failure that [#533](https://github.com/vantoan19/ticketd/issues/533) tracks.
- **A GHCR container image for webkit now.** It needs a `main`-only publish job with `packages: write` and a rebuild when the package list changes; apt timeouts and installing the packages only where they are needed come first.

## Why

A pull request took 32 to 39 minutes to reach `CI result`, and a docs-only one took as long, because nothing decided what a change needed and the Windows tests ran 89 binaries one after another. The targets are 15 minutes or less for a code pull request and 5 minutes or less for a docs-only one. Sharding shortens the longest job; the plan removes the jobs a change cannot affect.

The risk of a plan is a wrong "nothing to run", so every doubt resolves to everything: an unknown path costs minutes, a missed test costs a red `main`. The aggregate check is what makes skipping safe. It is the only required check, so it has to tell "the plan did not ask for this" from "this should have run and did not".

The table errs toward the Rust lane for files that Rust reads at compile time or in a test: the three frontend files embedded by the desktop crate, the chat bridge the desktop build bundles, `skills/**`, and `docs/sync-file-format.md`, whose examples a Rust test parses.

## Consequences

- A path that gains a hidden consumer has to be added to the table. A test failing only on `main` after a docs or frontend change that skipped the Rust lane is the sign; add the path to the table and a row to `scripts/ci-plan.test.mjs`.
- The `ci-full` label runs everything on demand, for a change the table cannot see. It is a pull request label, so it needs `labeled` and `unlabeled` among the `pull_request` triggers; the concurrency group cancels the superseded run.
- A new job needs a lane and a place in the plan check, so the aggregate check keeps covering every job.
- `main` and the nightly run use the same shards as pull requests, and always run every lane.
- The shard counts are a starting point (Windows 3, macOS 2, Linux 1, frontend 3), retuned from the timing table after a week of real runs.
