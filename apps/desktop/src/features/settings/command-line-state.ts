import type { CliStatus, OtherCli } from "@/lib/api/cli";

/** What the Command line page says about the `ticketd` agents would run. */
export type CommandLineKind =
  | "installed"
  | "not-installed"
  | "not-on-path"
  | "older"
  | "newer"
  | "different"
  | "no-version"
  | "other-workspace"
  | "workspace-unconfirmed";

/** The arguments of the one fix: the copy in the way, if there is one. */
export interface CommandLineFix {
  other: OtherCli | null;
}

function versionParts(version: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? match.slice(1).map(Number) : null;
}

function olderThanApp(version: string, appVersion: string) {
  const found = versionParts(version);
  const app = versionParts(appVersion);
  if (!found || !app) return null;
  for (let index = 0; index < 3; index += 1) {
    const difference = (found[index] ?? 0) - (app[index] ?? 0);
    if (difference !== 0) return difference < 0;
  }
  return null;
}

/**
 * The one repair for every cause this app's own copy can fix: not installed, not
 * on PATH, a broken link, or another copy first. Null when there is nothing to
 * run (it already matches, this build ships no copy, or on Linux the package
 * installs it). Set up ticketd calls this with the skills install.
 */
export function commandLineFix(status: CliStatus): CommandLineFix | null {
  const bundled = status.bundled;
  if (!bundled) return null;
  if (bundled.in_the_way) return { other: bundled.in_the_way };
  if (bundled.platform === "linux") return null;
  return !status.found || !status.on_path ? { other: null } : null;
}

export function commandLineKind(status: CliStatus): CommandLineKind {
  if (!status.found) return "not-installed";
  if (!status.on_path)
    return commandLineFix(status) ? "not-installed" : "not-on-path";
  if (status.version === null) return "no-version";
  if (status.version_matches === false) {
    const older = olderThanApp(status.version, status.app_version);
    return older === null ? "different" : older ? "older" : "newer";
  }
  if (status.workspace_matches === false) return "other-workspace";
  if (status.workspace_matches === null) return "workspace-unconfirmed";
  return "installed";
}
