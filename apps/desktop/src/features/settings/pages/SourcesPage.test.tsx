// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SourcesPage } from "@/features/settings/pages/SourcesPage";
import { SourceActivityContext } from "@/features/tickets/source-activity";
import type { SourceEntry, SourceStatus } from "@/lib/api/sources";
import type { GithubIntegration } from "@/lib/api/github";
import { githubSource, githubIntegration } from "@/test/source-fixtures";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(cleanup);

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

const github: SourceEntry = {
  ...githubSource,
  connector: {
    ...githubSource.connector,
    schema: { fields: [] },
    presentation: {
      ...githubSource.connector.presentation!,
      target: {
        field: "repositories",
        label: "Repository",
        example: "owner/name",
        choose: "Choose a repository",
        add: "Add a repository",
      },
    },
  },
  next_id: "github",
};
const linear: SourceEntry = {
  connector: {
    provider: "linear",
    name: "Linear",
    contract_version: 2,
    capabilities: ["discover", "fetch"],
    schema: {
      fields: [
        { key: "api_key", label: "API key", required: true, type: "secret" },
      ],
    },
    presentation: {
      sign_in: {},
      fields: {},
      hosts: [],
      target: {
        field: "team",
        label: "Team",
        example: "Platform",
        choose: "Choose a team",
        add: "Add a team",
      },
    },
  },
  saved: null,
  next_id: "linear",
};
const jira: SourceEntry = {
  connector: {
    provider: "jira",
    name: "Jira",
    contract_version: 2,
    capabilities: ["discover", "fetch"],
    schema: {
      fields: [
        { key: "token", label: "API token", required: true, type: "secret" },
      ],
    },
    presentation: {
      sign_in: {},
      fields: {},
      hosts: [],
      target: {
        field: "projects",
        label: "Project",
        example: "WEB",
        choose: "Choose a project",
        add: "Add a project",
      },
    },
  },
  saved: {
    id: "jira",
    name: "Jira",
    provider: "jira",
    account: "sam",
    config: { projects: ["WEB", "API"] },
    saved_at: "2026-11-01T00:00:00Z",
  },
  development: true,
  next_id: "jira-2",
};
const connectedGithub: SourceEntry = {
  ...github,
  saved: {
    id: "github",
    name: "GitHub",
    provider: "github",
    account: "sam-lee",
    config: {
      repositories: ["northwind/web", "northwind/api", "northwind/ios"],
    },
    saved_at: "2026-11-01T00:00:00Z",
  },
};

function status(
  provider: string,
  connection: string,
  extra: Partial<SourceStatus> = {},
): SourceStatus {
  return {
    provider,
    connection_id: connection,
    health: "synced",
    last_attempt_at: minutesAgo(4),
    last_refreshed_at: minutesAgo(4),
    error: null,
    failing_since: null,
    retry_after: null,
    unavailable_tickets: 0,
    partial_message: null,
    ...extra,
  };
}

function open(
  entries: SourceEntry[],
  sources: SourceStatus[] = [],
  onOpen: (id: string) => void = () => {},
  github: GithubIntegration | null = null,
) {
  render(
    <SourceActivityContext.Provider
      value={{
        refreshing: false,
        sources,
        entries,
        github,
        intervalSecs: null,
        openSettings: () => {},
        refreshAll: async () => {},
      }}
    >
      <SourcesPage onOpen={onOpen} />
    </SourceActivityContext.Provider>,
  );
}

function row(name: RegExp | string) {
  const button = screen.getByRole("button", { name });
  return within(button.closest("tr")!);
}

const connected = githubIntegration();
const withRepositories = {
  ...connected,
  repositories: ["web", "api", "ios"].map((name) => ({
    ...connected.repositories[0]!,
    repository: `github.com/northwind/${name}`,
    last_refreshed_at: minutesAgo(4),
  })),
};

test("a table shows each source's status, sign-in and what it brings in", () => {
  open(
    [
      connectedGithub,
      {
        ...connectedGithub,
        saved: { ...connectedGithub.saved!, id: "github-2" },
      },
      linear,
      jira,
    ],
    [
      status("github", "github"),
      status("jira", "jira", { last_refreshed_at: minutesAgo(12) }),
    ],
    undefined,
    withRepositories,
  );
  expect(
    screen.getAllByRole("columnheader").map((header) => header.textContent),
  ).toEqual(["Source", "Status", "Signs in with", "Brings in", "Open"]);

  expect(screen.getAllByRole("button", { name: /^GitHub/ })).toHaveLength(1);
  const gh = row(/^GitHub/);
  expect(gh.getByText("Built in")).toBeTruthy();
  expect(gh.getByText("Connected")).toBeTruthy();
  expect(gh.getByText("Your gh login")).toBeTruthy();
  expect(gh.getByText("3 repositories")).toBeTruthy();
  expect(gh.getByText("Refreshed 4 min ago")).toBeTruthy();

  const lin = row(/^Linear/);
  expect(lin.getByText("Built in")).toBeTruthy();
  expect(lin.getByText("Not connected")).toBeTruthy();
  expect(lin.getByText("An API key")).toBeTruthy();
  expect(lin.getByText("Nothing yet")).toBeTruthy();

  const custom = row(/^Jira/);
  expect(custom.getByText("Custom")).toBeTruthy();
  expect(custom.getByText("Development")).toBeTruthy();
  expect(custom.getByText("Connected")).toBeTruthy();
  expect(custom.getByText("An API token")).toBeTruthy();
  expect(custom.getByText("2 projects")).toBeTruthy();
  expect(custom.getByText("Refreshed 12 min ago")).toBeTruthy();

  expect(
    screen.getByText(
      "Connected on this computer only. Connect them again on your other computers.",
    ),
  ).toBeTruthy();
});

test("a first visit shows the same table with every source Not connected", () => {
  open([github, linear]);
  expect(screen.getAllByText("Not connected")).toHaveLength(2);
  expect(row(/^GitHub/).getByText("Your gh login")).toBeTruthy();
  expect(screen.getAllByText("Nothing yet")).toHaveLength(2);
  expect(screen.queryByText(/No connections yet/)).toBeNull();
});

test("a rejected sign-in reads Needs sign-in and a missing program reads Unavailable", () => {
  const archived: SourceEntry = {
    ...jira,
    development: false,
    unavailable: true,
    next_id: undefined as unknown as string,
  };
  open(
    [connectedGithub, archived],
    [
      status("github", "github", {
        health: "unavailable",
        error: { code: "unauthenticated", message: "Bad credentials" },
      }),
    ],
    undefined,
    githubIntegration("not_signed_in"),
  );
  expect(row(/^GitHub/).getByText("Needs sign-in")).toBeTruthy();
  expect(row(/^Jira/).getByText("Unavailable")).toBeTruthy();
});

test("a source that is only unreachable stays Connected", () => {
  open(
    [connectedGithub],
    [
      status("github", "github", {
        health: "delayed",
        error: { code: "rate_limited", message: "Try later" },
      }),
    ],
    undefined,
    connected,
  );
  expect(row(/^GitHub/).getByText("Connected")).toBeTruthy();
});

test("selecting a row opens that source's page, saved or not", () => {
  const onOpen = vi.fn();
  open(
    [
      connectedGithub,
      linear,
      { ...jira, saved: { ...jira.saved!, id: "jira-2" } },
    ],
    [],
    onOpen,
  );
  fireEvent.click(screen.getByRole("button", { name: /^GitHub/ }));
  fireEvent.click(screen.getByRole("button", { name: /^Linear/ }));
  fireEvent.click(screen.getByText("2 projects"));
  expect(onOpen.mock.calls.map(([id]) => id)).toEqual([
    "github",
    "linear",
    "jira-2",
  ]);
});

test("a connection with its own name shows that name", () => {
  open([
    {
      ...linear,
      saved: {
        id: "linear-2",
        name: "Linear · Design",
        provider: "linear",
        account: "sam",
        config: { team: ["design"] },
        saved_at: "2026-11-01T00:00:00Z",
      },
    },
  ]);
  const named = row(/^Linear · Design/);
  expect(named.getByText("1 team")).toBeTruthy();
});
