import { diagnosticsClient, type IssueDetails } from "@/lib/api/diagnostics";
import { workspaceClient } from "@/lib/api/workspace";

/** The form `.github/ISSUE_TEMPLATE/bug_report.yml` defines; its fields are filled by id. */
const BUG_FORM = "https://github.com/vantoan19/ticketd/issues/new";
const BUG_TEMPLATE = "bug_report.yml";

/**
 * The address of GitHub's bug form with its own `version` and `environment` fields filled
 * in. Opening it sends nothing: GitHub shows the form, and the person submits it. The
 * address stays inside the opener scope in `src-tauri/capabilities/default.json`.
 */
export function bugReportUrl({ version, environment }: IssueDetails): string {
  const query = [
    ["template", BUG_TEMPLATE],
    ["version", version],
    ["environment", environment],
  ]
    .map(([name, value]) => `${name}=${encodeURIComponent(value ?? "")}`)
    .join("&");
  return `${BUG_FORM}?${query}`;
}

/** Opens the bug form in the browser with this app's version and system filled in. */
export async function openBugReport(): Promise<void> {
  await workspaceClient.openLink(
    bugReportUrl(await diagnosticsClient.issueDetails()),
  );
}
