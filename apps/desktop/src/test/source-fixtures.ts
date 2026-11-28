import type { GithubHost, GithubIntegration } from "@/lib/api/github";
import type { SourceEntry } from "@/lib/api/sources";

export const githubSource: SourceEntry = {
  connector: {
    provider: "github",
    name: "GitHub",
    contract_version: 1,
    capabilities: ["discover", "fetch", "comments", "publish"],
    schema: { fields: [] },
    presentation: {
      icon_svg:
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg>',
      sign_in: {
        desktop_instruction:
          "Run “gh auth login” in a terminal, then choose Check connection.",
      },
      fields: {
        repositories: {
          placeholder: "e.g. acme/billing-api",
          additional_placeholder: "Add another repository",
        },
        labels: { placeholder: "e.g. bug, payments" },
        assignee: { placeholder: "e.g. octocat" },
      },
      target: {
        field: "repositories",
        label: "Repository",
        example: "owner/name",
        choose: "Choose a repository",
        add: "Add a repository",
      },
      discovery_note: "Pull requests are not included.",
      pull_request_link: { host: "github.com", segment: "pull" },
      hosts: ["api.github.com"],
    },
  },
  saved: null,
};

export const beaconIcon =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l10 20H2z"/><script>window.beaconIconRan = true</script></svg>';

export const beaconSource: SourceEntry = {
  connector: {
    provider: "beacon",
    name: "Beacon Tracker",
    contract_version: 1,
    capabilities: ["discover", "fetch"],
    schema: {
      fields: [
        {
          key: "team",
          label: "Team",
          required: true,
          type: "text",
          help: "Use a Beacon team key.",
        },
      ],
    },
    presentation: {
      icon_svg: beaconIcon,
      sign_in: {
        desktop_instruction: "Open Beacon Console and sign in.",
      },
      fields: { team: { placeholder: "e.g. PLATFORM" } },
      target: {
        field: "team",
        label: "Team",
        example: "PLATFORM",
        choose: "Choose a team",
        add: "Enter a team",
      },
      hosts: ["beacon.example"],
    },
  },
  saved: {
    provider: "beacon",
    config: { team: "PLATFORM" },
    account: "demo",
    saved_at: "2026-02-01T00:00:00Z",
  },
};

export function githubIntegration(
  state: GithubHost["state"] = "connected",
): GithubIntegration {
  return {
    id: "github",
    hosts: [
      {
        host: "github.com",
        state,
        login: state === "connected" ? "octo" : null,
        message: null,
      },
    ],
    repositories: [
      {
        repository: "github.com/acme/web",
        assignee: null,
        labels: [],
        project: null,
        project_login: null,
        tracked_tickets: 0,
        last_refreshed_at: null,
        error: null,
      },
    ],
    migration_notices: [],
  };
}
