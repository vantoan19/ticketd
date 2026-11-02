// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SourceCard } from "@/features/settings/sources/SourceCard";
import { SettingsNav } from "@/features/settings/SettingsNav";
import { SourceActivityContext } from "@/features/tickets/source-activity";
import {
  SourceFailure,
  sourcesClient,
  type DiscoveryPreview,
  type SourceEntry,
} from "@/lib/api/sources";

vi.mock("@/lib/api/sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/sources")>()),
  sourcesClient: {
    list: vi.fn(),
    checkConnection: vi.fn(),
    options: vi.fn(),
    preview: vi.fn(),
    save: vi.fn(),
  },
}));

const entry: SourceEntry = {
  connector: {
    provider: "github",
    name: "GitHub",
    contract_version: 1,
    capabilities: ["discover", "fetch"],
    schema: {
      fields: [
        {
          key: "repositories",
          label: "Repositories",
          help: "Issues from these repositories are discovered.",
          required: true,
          type: "multi_select",
          options: { source: "dynamic", depends_on: [] },
          allow_custom: true,
          min_items: 1,
          max_items: 2,
          format: "owner_name",
        },
        {
          key: "assignee",
          label: "Assignee",
          required: false,
          type: "text",
          placeholder: "username",
          format: "handle",
        },
      ],
    },
  },
  saved: null,
};

const preview: DiscoveryPreview = {
  provider: "github",
  account: "octo",
  issues: [
    {
      display: "o/r#1",
      url: "https://github.example/o/r/issues/1",
      title: "First issue",
      assignees: [],
      labels: [],
      updated_at: "",
    },
  ],
  matched: 1,
  complete: true,
};

beforeEach(() => {
  vi.mocked(sourcesClient.options).mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

async function addRepository(name: string) {
  const input = screen.getByLabelText(/Repositories/);
  fireEvent.change(input, { target: { value: name } });
  fireEvent.keyDown(input, { key: "Enter" });
  await screen.findByRole("button", { name: `Remove ${name}` });
}

test("a new source is not configured and cannot be saved before a preview", async () => {
  render(<SourceCard entry={entry} />);
  expect(screen.getByText("Not configured")).toBeTruthy();
  const save = screen.getByRole("button", { name: "Save" });
  expect((save as HTMLButtonElement).disabled).toBe(true);
  await addRepository("o/r");
  expect(screen.getByText("Unsaved changes")).toBeTruthy();
  expect((save as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Preview the matching issues/)).toBeTruthy();
});

test("preview lists matches, then Save turns discovery on without importing at once", async () => {
  vi.mocked(sourcesClient.preview).mockResolvedValue(preview);
  vi.mocked(sourcesClient.save).mockResolvedValue({
    source: {
      provider: "github",
      config: { repositories: ["o/r"] },
      account: "octo",
      saved_at: "2026-01-01T00:00:00Z",
    },
    preview,
  });
  render(<SourceCard entry={entry} />);
  await addRepository("o/r");
  fireEvent.click(screen.getByRole("button", { name: "Preview matches" }));
  const panel = await screen.findByRole("region", { name: "Preview" });
  expect(panel.textContent).toContain("1 matching issue");
  expect(panel.textContent).toContain("First issue");
  expect(panel.textContent).toContain("nothing has been imported");
  expect(sourcesClient.preview).toHaveBeenCalledWith("github", {
    repositories: ["o/r"],
  });

  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText(/Matching issues are imported on the next refresh/);
  expect(sourcesClient.save).toHaveBeenCalledWith("github", {
    repositories: ["o/r"],
  });
  expect(screen.getByText("Saved configuration")).toBeTruthy();
});

test("editing after a preview makes the preview stale and blocks Save", async () => {
  vi.mocked(sourcesClient.preview).mockResolvedValue(preview);
  render(<SourceCard entry={entry} />);
  await addRepository("o/r");
  fireEvent.click(screen.getByRole("button", { name: "Preview matches" }));
  await screen.findByRole("region", { name: "Preview" });
  fireEvent.change(screen.getByLabelText("Assignee"), {
    target: { value: "octo" },
  });
  expect(screen.queryByRole("region", { name: "Preview" })).toBeNull();
  expect(screen.getByText(/rules changed/)).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("an empty preview is allowed and a provider failure keeps the draft", async () => {
  vi.mocked(sourcesClient.preview)
    .mockRejectedValueOnce(
      new SourceFailure("unauthenticated", "GitHub rejected the credential"),
    )
    .mockResolvedValueOnce({ ...preview, issues: [], matched: 0 });
  render(<SourceCard entry={entry} />);
  await addRepository("o/r");
  fireEvent.click(screen.getByRole("button", { name: "Preview matches" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "rejected the credential",
  );
  expect(screen.getByRole("button", { name: "Remove o/r" })).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);

  fireEvent.click(screen.getByRole("button", { name: "Preview matches" }));
  const panel = await screen.findByRole("region", { name: "Preview" });
  expect(panel.textContent).toContain("No open issues match these rules");
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
});

test("a partial count is labeled as a minimum", async () => {
  vi.mocked(sourcesClient.preview).mockResolvedValue({
    ...preview,
    matched: 200,
    complete: false,
  });
  render(<SourceCard entry={entry} />);
  await addRepository("o/r");
  fireEvent.click(screen.getByRole("button", { name: "Preview matches" }));
  const panel = await screen.findByRole("region", { name: "Preview" });
  expect(panel.textContent).toContain("At least 200 matching issues");
  expect(panel.textContent).toContain("Showing the first 1");
});

test("field problems from the core appear beside their fields", async () => {
  vi.mocked(sourcesClient.preview).mockRejectedValue(
    new SourceFailure("invalid_configuration", "invalid", null, [
      { field: "assignee", message: "must be a username" },
    ]),
  );
  render(<SourceCard entry={entry} />);
  await addRepository("o/r");
  fireEvent.change(screen.getByLabelText("Assignee"), {
    target: { value: "-x-" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview matches" }));
  await screen.findByText("Assignee must be a username");
  expect(screen.getByLabelText("Assignee").getAttribute("aria-invalid")).toBe(
    "true",
  );
});

test("a saved configuration is shown as saved until edited", () => {
  render(
    <SourceCard
      entry={{
        ...entry,
        saved: {
          provider: "github",
          config: { repositories: ["o/r"], assignee: "octo" },
          account: "octo",
          saved_at: "2026-01-01T00:00:00Z",
        },
      }}
    />,
  );
  expect(screen.getByText("Saved configuration")).toBeTruthy();
  expect((screen.getByLabelText("Assignee") as HTMLInputElement).value).toBe(
    "octo",
  );
  fireEvent.change(screen.getByLabelText("Assignee"), {
    target: { value: "someone" },
  });
  expect(screen.getByText("Unsaved changes")).toBeTruthy();
  expect(screen.getByText(/still applies until you save/)).toBeTruthy();
});

test("dynamic suggestions come from the connector and can be picked", async () => {
  vi.useFakeTimers();
  vi.mocked(sourcesClient.options).mockResolvedValue([
    { value: "o/alpha", label: "o/alpha", description: "Private" },
  ]);
  render(<SourceCard entry={entry} />);
  fireEvent.focus(screen.getByLabelText(/Repositories/));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  expect(sourcesClient.options).toHaveBeenCalledWith(
    "github",
    "repositories",
    "",
    {},
  );
  fireEvent.click(screen.getByRole("button", { name: "Add o/alpha" }));
  expect(screen.getByRole("button", { name: "Remove o/alpha" })).toBeTruthy();
});

test("checking the connection names the account", async () => {
  vi.mocked(sourcesClient.checkConnection).mockResolvedValue({
    account: "octo",
  });
  render(<SourceCard entry={entry} />);
  fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
  await screen.findByText("Connected as octo.");
});

test("the section list offers a source only when its connector is available", async () => {
  vi.mocked(sourcesClient.list).mockResolvedValue([]);
  const { unmount } = render(<SettingsNav onBack={() => {}} />);
  await act(async () => {});
  expect(screen.queryByRole("group", { name: "Sources" })).toBeNull();
  unmount();

  vi.mocked(sourcesClient.list).mockResolvedValue([entry]);
  render(<SettingsNav onBack={() => {}} />);
  const group = await screen.findByRole("group", { name: "Sources" });
  expect(group.textContent).toContain("GitHub");
});

test("a saved source says how often it refreshes and when it last did", () => {
  render(
    <SourceActivityContext.Provider
      value={{
        refreshing: false,
        sources: [
          {
            provider: "github",
            health: "synced",
            last_attempt_at: "2026-02-01T00:00:00Z",
            last_refreshed_at: new Date(Date.now() - 4 * 60_000).toISOString(),
            error: null,
            failing_since: null,
            retry_after: null,
            unavailable_tickets: 0,
            partial_message: null,
          },
        ],
        entries: null,
        intervalSecs: 300,
        openSettings: () => {},
        refreshAll: async () => {},
      }}
    >
      <SourceCard
        entry={{
          ...entry,
          saved: {
            provider: "github",
            config: { repositories: ["o/r"] },
            account: "octo",
            saved_at: "2026-02-01T00:00:00Z",
          },
        }}
      />
    </SourceActivityContext.Provider>,
  );
  expect(
    screen.getByText(/Refreshes about every 5 minutes while ticketd is open/),
  ).toBeTruthy();
  expect(screen.getByText(/Last refreshed 4 min ago/)).toBeTruthy();
});
