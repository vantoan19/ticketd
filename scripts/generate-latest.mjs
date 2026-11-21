import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const releaseBase = "https://github.com/vantoan19/ticketd/releases";
const formatSource = new URL(
  "../crates/ticketd-core/src/format.rs",
  import.meta.url,
);
const targets = [
  [".app.tar.gz", ["darwin-aarch64"]],
  [".deb", ["linux-x86_64-deb", "linux-x86_64"]],
  [".msi", ["windows-x86_64-msi", "windows-x86_64"]],
];

function generate(version, pubDate, directory) {
  const output = join(directory, "latest.json");
  rmSync(output, { force: true });
  const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const hasUpdaterSignature = targets.some(([extension]) =>
    files.some((file) => file.endsWith(`${extension}.sig`)),
  );
  if (!hasUpdaterSignature) {
    console.warn(
      "Skipping latest.json because no updater signatures were staged.",
    );
    return;
  }

  const tag = `v${encodeURIComponent(version)}`;
  const platforms = {};
  for (const [extension, keys] of targets) {
    const candidates = files.filter((file) => file.endsWith(extension));
    if (candidates.length !== 1) {
      throw new Error(
        `Expected one ${extension} asset, found ${candidates.length}`,
      );
    }
    const [asset] = candidates;
    if (!files.includes(`${asset}.sig`))
      throw new Error(`Missing signature ${asset}.sig`);
    const signature = readFileSync(
      join(directory, `${asset}.sig`),
      "utf8",
    ).trim();
    if (!signature) throw new Error(`Empty signature for ${asset}`);
    const update = {
      signature,
      url: `${releaseBase}/download/${tag}/${encodeURIComponent(asset)}`,
    };
    for (const key of keys) platforms[key] = update;
  }

  const format = readFileSync(formatSource, "utf8").match(
    /^pub const FORMAT_VERSION: i64 = ([1-9]\d*);$/m,
  );
  if (!format) throw new Error("Missing workspace format version");

  const manifest = {
    version,
    format_version: Number(format[1]),
    pub_date: pubDate,
    notes: `${releaseBase}/tag/${tag}`,
    platforms,
  };
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
}

try {
  const [version, pubDate, directory] = process.argv.slice(2);
  if (!version || !pubDate || !directory || process.argv.length !== 5) {
    throw new Error(
      "Usage: node scripts/generate-latest.mjs <version> <RFC3339-date> <asset-directory>",
    );
  }
  generate(version, pubDate, directory);
} catch (error) {
  console.error(`Cannot generate latest.json: ${error.message}`);
  process.exitCode = 1;
}
