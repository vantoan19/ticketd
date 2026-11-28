// @vitest-environment jsdom
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { SettingsView } from "@/features/settings/SettingsView";
import { SourceActivityContext } from "@/features/tickets/source-activity";
import { invoke } from "@tauri-apps/api/core";
import { sourcesClient } from "@/lib/api/sources";
import {
  getGithubIntegration,
  removeGithubRepository,
  signInGithub,
  type GithubIntegration,
} from "@/lib/api/github";
import { githubSource } from "@/test/source-fixtures";

vi.mock("@/lib/api/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/github")>()),
  getGithubIntegration: vi.fn(),
  signInGithub: vi.fn(),
  removeGithubRepository: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

const signedOut: GithubIntegration = {
  id: "github",
  hosts: [
    { host: "github.com", state: "not_signed_in", login: null, message: null },
  ],
  repositories: [],
  migration_notices: [],
};

function open(integration: GithubIntegration) {
  vi.mocked(getGithubIntegration).mockResolvedValue(integration);
  render(
    <SourceActivityContext
      value={{
        refreshing: false,
        sources: [],
        entries: [githubSource],
        intervalSecs: 300,
        openSettings: () => {},
        refreshAll: async () => {},
      }}
    >
      <SettingsView selected="source-github" onRestore={async () => {}} />
    </SourceActivityContext>,
  );
}

test("signing in from GitHub Settings hands off to gh and shows the one-time code while it waits", async () => {
  vi.mocked(signInGithub).mockImplementation(async (_host, onCode) => {
    onCode("ABCD-EFGH");
    return new Promise(() => {});
  });
  open(signedOut);

  expect(await screen.findByText("Not signed in")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

  expect(signInGithub).toHaveBeenCalledWith("github.com", expect.any(Function));
  expect(screen.getByText("ABCD-EFGH")).toBeTruthy();
});

const connected: GithubIntegration = {
  ...signedOut,
  hosts: [
    { host: "github.com", state: "connected", login: "sam-lee", message: null },
  ],
  repositories: [
    {
      repository: "github.com/northwind/payments-api",
      assignee: null,
      labels: [],
      project: { id: "payments", name: "Payments API" },
      project_login: null,
      tracked_tickets: 42,
      last_refreshed_at: null,
      error: null,
    },
    {
      repository: "github.com/northwind/web",
      assignee: null,
      labels: ["bug"],
      project: { id: "website", name: "Website" },
      project_login: "work-account",
      tracked_tickets: 9,
      last_refreshed_at: null,
      error: null,
    },
    {
      repository: "github.com/sam-lee/dotfiles",
      assignee: "sam-lee",
      labels: [],
      project: null,
      project_login: null,
      tracked_tickets: 3,
      last_refreshed_at: null,
      error: null,
    },
  ],
};

test("repository rows show matching Project routes and open their filters from the keyboard", async () => {
  open(connected);
  expect(
    await screen.findByText("All open issues → Payments API · 42 tickets"),
  ).toBeTruthy();
  expect(
    screen.getByText("Open issues labeled bug → Website · 9 tickets"),
  ).toBeTruthy();
  expect(
    screen.getByText("Open issues assigned to you → No project · 3 tickets"),
  ).toBeTruthy();

  const row = screen.getByRole("button", { name: "northwind/web" });
  row.focus();
  await userEvent.keyboard("{Enter}");
  expect(row.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("textbox", { name: "Assignee" })).toBeTruthy();
  expect(screen.getByText(/work-account/)).toBeTruthy();
});

test("Refresh now refreshes GitHub and displays the latest successful refresh time", async () => {
  const refresh = vi
    .spyOn(sourcesClient, "refresh")
    .mockImplementation(async () => {
      const timestamp = new Date().toISOString();
      vi.mocked(getGithubIntegration).mockResolvedValue({
        ...connected,
        repositories: connected.repositories.map((row) => ({
          ...row,
          last_refreshed_at: timestamp,
        })),
      });
      return {
        imported: [],
        updated: [],
        unchanged: 0,
        failures: [],
        refreshed_at: timestamp,
      };
    });
  open(connected);
  await userEvent.click(
    await screen.findByRole("button", { name: "Refresh now" }),
  );

  expect(refresh).toHaveBeenCalledWith(undefined, "github");
  expect(await screen.findByText(/Refreshed just now/)).toBeTruthy();
});

test("Remove asks before stopping the selected repository and explains what its tickets keep", async () => {
  vi.mocked(removeGithubRepository).mockImplementation(async (repository) => {
    vi.mocked(getGithubIntegration).mockResolvedValue({
      ...connected,
      repositories: connected.repositories.filter(
        (entry) => entry.repository !== repository,
      ),
    });
  });
  open(connected);

  const remove = await screen.findByRole(
    "button",
    { name: "Remove northwind/web" },
    { timeout: 500 },
  );
  await userEvent.click(remove);
  const dialog = screen.getByRole("dialog", {
    name: "Stop bringing in northwind/web?",
  });
  expect(
    within(dialog).getByText(
      "Its 9 tickets keep their last synced content and your work.",
    ),
  ).toBeTruthy();
  expect(removeGithubRepository).not.toHaveBeenCalled();
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("button", { name: "northwind/web" })).toBeTruthy();

  await userEvent.click(remove);
  await userEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }),
  );
  expect(removeGithubRepository).toHaveBeenCalledWith(
    "github.com/northwind/web",
  );
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "northwind/web" })).toBeNull(),
  );
  expect(
    screen.getByRole("button", { name: "northwind/payments-api" }),
  ).toBeTruthy();
});

test("adding the first Enterprise repository checks its full site and offers cancellable sign-in", async () => {
  vi.mocked(invoke).mockResolvedValue({
    host: "github.example.test:8443",
    state: "not_signed_in",
    login: null,
    message: null,
  });
  vi.mocked(signInGithub).mockImplementation(async (_host, onCode) => {
    onCode("ABCD-EFGH");
    return new Promise(() => {});
  });
  open(connected);
  await userEvent.click(
    await screen.findByRole("button", { name: "Add a repository" }),
  );
  const dialog = within(
    screen.getByRole("dialog", { name: "Add a repository" }),
  );
  const host = dialog.getByRole("textbox", { name: "GitHub host" });
  await userEvent.clear(host);
  await userEvent.type(host, "github.example.test:8443");
  await userEvent.click(dialog.getByRole("button", { name: "Check sign-in" }));
  expect(invoke).toHaveBeenCalledWith("get_github_host_readiness", {
    host: "github.example.test:8443",
  });
  await userEvent.click(await dialog.findByRole("button", { name: "Sign in" }));
  expect(signInGithub).toHaveBeenCalledWith(
    "github.example.test:8443",
    expect.any(Function),
  );
  expect(dialog.getByText("ABCD-EFGH")).toBeTruthy();
  await userEvent.click(dialog.getByRole("button", { name: "Cancel sign-in" }));
  expect(invoke).toHaveBeenCalledWith("cancel_github_sign_in", {
    host: "github.example.test:8443",
  });
});
