// Decides whether the Release workflow drafts a release for a commit, and which existing drafts
// that draft replaces. The workflow runs it before building and again just before it writes.
//
//   auto    a green main push (workflow_run). Every such commit is built; it is drafted only
//           when its version has no published release yet. A missing draft is created and a
//           draft of this same commit is replaced, but a draft built from another commit is
//           left alone, because the maintainer may be testing it.
//   manual  a workflow_dispatch rerun or dry run. Refuses a commit that is not a green main
//           commit, and a version that is published or not newer than the latest release.
//           Replaces any draft of that version.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  compareVersions,
  gh,
  isPrerelease,
  latestPublished,
  listReleases,
  parseVersion,
} from "./release-version.mjs";

export function planDraft({ mode, sha, version, releases, onMain, green }) {
  if (mode !== "auto" && mode !== "manual")
    throw new Error(`Unknown mode ${mode}`);
  parseVersion(version);
  const tag = `v${version}`;
  const decline = (reason) => {
    if (mode === "manual") throw new Error(reason);
    return { draft: false, tag, version, reason };
  };

  if (mode === "manual") {
    if (!onMain)
      decline(
        `${sha} is not on main. Release drafts build only reviewed main commits.`,
      );
    if (!green) decline(`Quality has not passed for ${sha} as a push to main.`);
  }
  if (releases.some((release) => !release.draft && release.tag_name === tag)) {
    return decline(
      `${tag} is already published, and a published release is never replaced. Release a new version instead.`,
    );
  }
  const latest = latestPublished(releases);
  if (latest !== null && compareVersions(version, latest) <= 0) {
    return decline(
      `${version} is not newer than the latest published release, v${latest}.`,
    );
  }
  const drafts = releases.filter(
    (release) => release.draft && release.tag_name === tag,
  );
  const other = drafts.find((release) => release.target_commitish !== sha);
  if (mode === "auto" && other) {
    return decline(
      `The draft ${tag} was built from ${other.target_commitish}, and a later commit does not replace a draft that may be under test. Run the Release workflow by hand to rebuild it from ${sha}.`,
    );
  }
  return {
    draft: true,
    tag,
    version,
    prerelease: isPrerelease(version),
    replace: drafts.map((release) => release.id),
    reason: drafts.length
      ? `Replacing the draft ${tag} with a build of ${sha}.`
      : `Creating the draft ${tag} from ${sha}.`,
  };
}

function appVersionAt(repository, sha) {
  const config = gh([
    "api",
    "-H",
    "Accept: application/vnd.github.raw+json",
    `repos/${repository}/contents/apps/desktop/src-tauri/tauri.conf.json?ref=${sha}`,
  ]);
  return JSON.parse(config).version;
}

function resolveCommit(repository, mode, requested) {
  let sha = requested;
  if (!sha && mode === "manual") {
    sha = gh([
      "api",
      `repos/${repository}/actions/workflows/quality.yml/runs?branch=main&event=push&status=success&per_page=1`,
      "--jq",
      ".workflow_runs[0].head_sha // empty",
    ]).trim();
    if (!sha) throw new Error("No green main commit found.");
  }
  if (!/^[0-9a-f]{7,40}$/.test(sha ?? ""))
    throw new Error(`"${sha}" is not a commit SHA.`);
  return gh([
    "api",
    `repos/${repository}/commits/${sha}`,
    "--jq",
    ".sha",
  ]).trim();
}

function main() {
  const { values } = parseArgs({
    options: {
      mode: { type: "string" },
      sha: { type: "string", default: "" },
      "version-override": { type: "string", default: "" },
    },
  });
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("GITHUB_REPOSITORY is not set");
  const { mode } = values;
  const override = mode === "manual" ? values["version-override"].trim() : "";
  const sha = resolveCommit(repository, mode, values.sha.trim());

  let onMain = false;
  let green = false;
  if (mode === "manual") {
    const status = gh([
      "api",
      `repos/${repository}/compare/main...${sha}`,
      "--jq",
      ".status",
    ]).trim();
    onMain = status === "behind" || status === "identical";
    green =
      Number(
        gh([
          "api",
          `repos/${repository}/actions/workflows/quality.yml/runs?head_sha=${sha}&event=push&status=success&per_page=1`,
          "--jq",
          ".total_count",
        ]),
      ) > 0;
  }

  const plan = planDraft({
    mode,
    sha,
    version: override || appVersionAt(repository, sha),
    releases: listReleases(repository),
    onMain,
    green,
  });
  const outputs = {
    sha,
    short: sha.slice(0, 7),
    version: plan.version,
    tag: plan.tag,
    override,
    draft: plan.draft,
    prerelease: plan.prerelease ?? false,
    replace: (plan.replace ?? []).join(" "),
  };
  const lines = Object.entries(outputs).map(
    ([key, value]) => `${key}=${value}\n`,
  );
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, lines.join(""));
  else process.stdout.write(lines.join(""));
  console.error(plan.reason);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${plan.reason}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
