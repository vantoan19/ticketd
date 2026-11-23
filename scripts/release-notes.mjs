// Release notes: a hand-written section on top of GitHub's generated notes.
//
//   node scripts/release-notes.mjs pr-body --version 0.2.0
//     The version-bump PR body, with the hand-written section drafted between markers.
//   node scripts/release-notes.mjs pr-link --version 0.2.0
//     A link that opens that PR, prefilled, for when the workflow token may not open PRs.
//   node scripts/release-notes.mjs release --version 0.2.0 --sha <sha> --source <checkout> --out <file>
//     The draft release body: the hand-written section from the merged version-bump PR (or the
//     template when the commit has none, as in a dry run), then GitHub's generated notes,
//     grouped by .github/release.yml.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  gh,
  isPrerelease,
  parseVersion,
  readAppVersion,
} from "./release-version.mjs";

const repository = "vantoan19/ticketd";
const start = "<!-- release-notes:start -->";
const end = "<!-- release-notes:end -->";

export function formatVersion(source) {
  const match = readFileSync(
    join(source, "crates/ticketd-core/src/format.rs"),
    "utf8",
  ).match(/^pub const FORMAT_VERSION: i64 = ([1-9]\d*);$/m);
  if (!match) throw new Error("Missing workspace format version");
  return Number(match[1]);
}

// Based on the v0.1.0 notes. HTML comments are prompts for the maintainer; GitHub hides any
// that are left in. The callouts, Downloads and the footer name the version; the rest is the
// maintainer's.
const overviewPrompt =
  "<!-- One or two sentences on what this release is for. -->";

function callouts(version) {
  const blob = `https://github.com/${repository}/blob/v${version}`;
  const prerelease = isPrerelease(version)
    ? "> [!NOTE]\n> **Prerelease.** In-app updates never offer a prerelease; install it by hand.\n\n"
    : "";
  return `${prerelease}> [!IMPORTANT]
> **Unsigned preview.** This build is not code signed or notarized. macOS and Windows warn before the first launch. The [install guide](${blob}/docs/install.md) has the steps:
>
> - **macOS:** \`/usr/bin/xattr -dr com.apple.quarantine /Applications/ticketd.app\`, or **Open Anyway** in System Settings → Privacy & Security.
> - **Windows:** SmartScreen's **More info → Run anyway**. Smart App Control blocks unsigned installers; build from source there.`;
}

function downloads(version) {
  return `## Downloads

| Platform | Desktop (includes the CLI) | Standalone CLI, for machines without the desktop |
| --- | --- | --- |
| macOS 26, Apple Silicon | \`ticketd_${version}_aarch64.dmg\` | \`ticketd-cli-${version}-macos-arm64.tar.gz\` |
| Ubuntu 24.04, x86-64 | \`ticketd_${version}_amd64.deb\` | \`ticketd-cli-${version}-linux-x86_64.tar.gz\` |
| Windows 11, x86-64 | \`ticketd_${version}_x64_en-US.msi\` | \`ticketd-cli-${version}-windows-x86_64.zip\` |

The desktop includes a \`ticketd\` CLI of the same version: **Settings → Command line → Install command-line tool** puts it on your PATH (the \`.deb\` installs it in \`/usr/bin\`). Check downloads against \`SHA256SUMS\`. Every file has a build-provenance attestation: \`gh attestation verify <file> --repo ${repository}\`.`;
}

const footerStart = "Full documentation:";

function footer(version) {
  const blob = `https://github.com/${repository}/blob/v${version}`;
  return `${footerStart} [README](${blob}/README.md) · [Install](${blob}/docs/install.md) · [CLI](${blob}/docs/cli.md)`;
}

export function handWrittenNotes(version, format) {
  return [
    overviewPrompt,
    callouts(version),
    downloads(version),
    `## Compatibility

- Workspace format: ${format}. <!-- Say whether this release raises it. A raise makes this a minor release: ticketd migrates the workspace when it opens it, and older binaries, on other Sync devices or as a standalone CLI, refuse it afterwards. Back up before upgrading. -->
- <!-- CLI changes that scripts or agents read, or "No CLI changes." -->`,
    `## Known limitations

- <!-- Which platforms were installed and tested by hand for this release. -->
- Not signed or notarized (see above). There is no Homebrew cask yet.
- A standalone CLI is updated by downloading the new archive.
- Linux packaging is \`.deb\` only.`,
    footer(version),
  ].join("\n\n");
}

// Notes written for one version, rewritten for another, as when a dry run overrides the
// version of a merged version-bump commit. The overview (text before the first heading, minus
// its callouts) and every section but Downloads are kept as written; the callouts, Downloads and
// the footer are generated for `version`.
export function retargetNotes(notes, version) {
  const lines = notes.split("\n");
  const firstHeading = lines.findIndex((line) => line.startsWith("## "));
  const preamble = firstHeading === -1 ? lines : lines.slice(0, firstHeading);
  const overview = preamble
    .filter((line) => !line.startsWith(">"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const sections = [];
  for (const line of firstHeading === -1 ? [] : lines.slice(firstHeading)) {
    if (line.startsWith(footerStart)) continue;
    if (line.startsWith("## ")) sections.push([line]);
    else sections.at(-1).push(line);
  }
  const body = sections.map((section) =>
    section[0].trim() === "## Downloads"
      ? downloads(version)
      : section.join("\n").trim(),
  );
  return [overview, callouts(version), ...body, footer(version)]
    .filter(Boolean)
    .join("\n\n");
}

export function extractNotes(body) {
  const from = body?.indexOf(start) ?? -1;
  const to = body?.indexOf(end) ?? -1;
  if (from === -1 || to < from) return null;
  const notes = body.slice(from + start.length, to).trim();
  return notes || null;
}

export function versionBumpBody(version, format) {
  return `Sets the version to ${version} in \`Cargo.toml\`, the \`package.json\` files and \`tauri.conf.json\`, and the workspace's own entries in \`Cargo.lock\` and \`package-lock.json\`. Opened by the Version bump workflow.

## Before merging

1. **Start CI.** A PR opened with the workflow token does not trigger workflows. If no Quality run appears below, close this PR and reopen it; that starts Quality, and \`CI result\` must pass before merging. A PR you opened yourself from the workflow's link runs CI as usual.
2. **Write the release notes** below: edit this description, keeping the two marker comments. GitHub's generated notes, grouped by PR label, are added under them.
3. **Merge.** When \`CI result\` passes on the merge commit, the Release workflow builds that exact commit and creates the draft release v${version} with every file, \`SHA256SUMS\` and build attestations. Then follow [Test a draft release](https://github.com/${repository}/blob/main/docs/releasing.md#test-a-draft-release).

## Release notes

${start}
${handWrittenNotes(version, format)}
${end}
`;
}

export function versionBumpLink(version, body) {
  parseVersion(version);
  const query = new URLSearchParams({
    quick_pull: "1",
    labels: "release",
    title: `Release ${version}`,
    body,
  });
  // A valid version has only URL-safe characters, and GitHub expects the branch's slash as is.
  return `https://github.com/${repository}/compare/main...release/v${version}?${query}`;
}

function releaseBody({ version, sha, source }) {
  const pulls = JSON.parse(
    gh(["api", `repos/${repository}/commits/${sha}/pulls`]),
  );
  const merged = pulls.find(
    (pull) => pull.merged_at && extractNotes(pull.body),
  );
  // A version override (a dry run) gets the merged notes rewritten for its own files.
  const commitVersion = readAppVersion(source);
  const authored = merged ? extractNotes(merged.body) : null;
  const handWritten = !authored
    ? handWrittenNotes(version, formatVersion(source))
    : version === commitVersion
      ? authored
      : retargetNotes(authored, version);
  const generated = gh([
    "api",
    "-X",
    "POST",
    `repos/${repository}/releases/generate-notes`,
    "-f",
    `tag_name=v${version}`,
    "-f",
    `target_commitish=${sha}`,
    "--jq",
    ".body",
  ]).trim();
  const origin = merged
    ? `Hand-written notes from #${merged.number}.`
    : "No merged PR with release notes; using the template.";
  return { body: `${handWritten}\n\n${generated}\n`, origin };
}

function main(args) {
  const [command, ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: {
      version: { type: "string" },
      sha: { type: "string" },
      source: { type: "string" },
      out: { type: "string" },
    },
  });
  if ((command === "pr-body" || command === "pr-link") && values.version) {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const body = versionBumpBody(values.version, formatVersion(root));
    if (command === "pr-body") process.stdout.write(body);
    else console.log(versionBumpLink(values.version, body));
    return;
  }
  if (
    command === "release" &&
    values.version &&
    values.sha &&
    values.source &&
    values.out
  ) {
    const { body, origin } = releaseBody(values);
    writeFileSync(values.out, body);
    console.log(origin);
    return;
  }
  throw new Error(
    "Usage: node scripts/release-notes.mjs pr-body --version <v> | pr-link --version <v> | release --version <v> --sha <sha> --source <checkout> --out <file>",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
