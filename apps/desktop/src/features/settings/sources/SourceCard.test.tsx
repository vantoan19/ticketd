// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SourceCard } from "@/features/settings/sources/SourceCard";
import { SettingsNav } from "@/features/settings/SettingsNav";
import { SettingsView } from "@/features/settings/SettingsView";
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
  expect(panel.textContent).toContain("1 issue matches");
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
  fireEvent.change(screen.getByLabelText(/Assignee/), {
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
  expect(panel.textContent).toContain("at least 200 issues match");
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
  fireEvent.change(screen.getByLabelText(/Assignee/), {
    target: { value: "-x-" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview matches" }));
  await screen.findByText("Assignee must be a username");
  expect(screen.getByLabelText(/Assignee/).getAttribute("aria-invalid")).toBe(
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
  expect((screen.getByLabelText(/Assignee/) as HTMLInputElement).value).toBe(
    "octo",
  );
  fireEvent.change(screen.getByLabelText(/Assignee/), {
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

test("opening a source keeps its page heading visible and focuses it for keyboard navigation", async () => {
  vi.mocked(sourcesClient.list).mockResolvedValue([entry]);
  const frame = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => {
      callback(0);
      return 0;
    });
  try {
    const { container } = render(
      <>
        <SettingsNav onBack={() => {}} onSelect={() => {}} />
        <div className="settings-page">
          <h1 id="settings-heading" tabIndex={-1}>
            GitHub settings
          </h1>
          <div id="settings-source-github">Connection card</div>
        </div>
      </>,
    );
    const page = container.querySelector(".settings-page")!;
    page.scrollTop = 200;
    const scrollCard = vi.fn();
    document.getElementById("settings-source-github")!.scrollIntoView =
      scrollCard;
    fireEvent.click(await screen.findByRole("button", { name: "GitHub" }));
    expect(page.scrollTop).toBe(0);
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "GitHub settings" }),
    );
    expect(scrollCard).not.toHaveBeenCalled();
  } finally {
    frame.mockRestore();
  }
});

test("switching settings sections retains the source draft and its preview", async () => {
  vi.mocked(sourcesClient.list).mockResolvedValue([entry]);
  vi.mocked(sourcesClient.preview).mockResolvedValue(preview);
  const props = { onRestore: async () => {}, onOpenInbox: () => {} };
  const { rerender, unmount } = render(
    <SettingsView {...props} selected="source-github" />,
  );
  await screen.findByRole("heading", { name: "Discovery" });
  await addRepository("o/r");
  fireEvent.change(screen.getByLabelText(/Assignee/), {
    target: { value: "octo" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview matches" }));
  await screen.findByRole("region", { name: "Preview" });
  expect(screen.getByRole("button", { name: "Save" })).toHaveProperty(
    "disabled",
    false,
  );

  rerender(<SettingsView {...props} selected="appearance" />);
  expect(screen.queryByRole("heading", { name: "Discovery" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: /Assignee/ })).toBeNull();
  rerender(<SettingsView {...props} selected="source-github" />);
  expect(screen.getByLabelText(/Assignee/)).toHaveProperty("value", "octo");
  expect(screen.getByRole("region", { name: "Preview" }).textContent).toContain(
    "First issue",
  );
  expect(screen.getByRole("button", { name: "Save" })).toHaveProperty(
    "disabled",
    false,
  );
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(screen.getByLabelText(/Assignee/)).toHaveProperty("value", "");
  expect(screen.queryByRole("region", { name: "Preview" })).toBeNull();

  // Drafts belong to this Settings visit, not a later workspace or visit.
  unmount();
  render(<SettingsView {...props} selected="source-github" />);
  expect(await screen.findByLabelText(/Assignee/)).toHaveProperty("value", "");
});

test("opening a source for the first time uses its latest saved configuration", () => {
  const saved = (assignee: string): SourceEntry => ({
    ...entry,
    saved: {
      provider: "github",
      config: { repositories: ["o/r"], assignee },
      account: "octo",
      saved_at: "2026-02-01T00:00:00Z",
    },
  });
  const view = (assignee: string, selected: "appearance" | "source-github") => (
    <SourceActivityContext.Provider
      value={{
        refreshing: false,
        sources: [],
        entries: [saved(assignee)],
        intervalSecs: 300,
        openSettings: () => {},
        refreshAll: async () => {},
      }}
    >
      <SettingsView
        selected={selected}
        onRestore={async () => {}}
        onOpenInbox={() => {}}
      />
    </SourceActivityContext.Provider>
  );
  const { rerender } = render(view("before", "appearance"));
  rerender(view("after", "appearance"));
  rerender(view("after", "source-github"));
  expect(screen.getByLabelText(/Assignee/)).toHaveProperty("value", "after");
});

test("a saved source says how often it refreshes, when it last did, and the core's checked-ticket total", () => {
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
            last_checked_tickets: 18,
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
  expect(screen.getByText(/every 5 minutes while it is open/)).toBeTruthy();
  expect(screen.getByText(/Last refreshed 4 min ago/)).toBeTruthy();
  expect(screen.getByText(/18 GitHub tickets checked/)).toBeTruthy();
});

test("rules equal to the saved configuration are not described as changed", async () => {
  vi.mocked(sourcesClient.preview).mockResolvedValue(preview);
  render(
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
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Remove o/r" }));
  await addRepository("o/r");
  expect(screen.getByText("Saved configuration")).toBeTruthy();
  expect(screen.queryByText(/The rules changed/)).toBeNull();
  expect(
    screen.getByText(/These rules are the saved configuration/),
  ).toBeTruthy();
});

test("an unavailable source never claims a fresh sync or a green configuration", () => {
  const { container } = render(
    <SourceActivityContext.Provider
      value={{
        refreshing: false,
        sources: [
          {
            provider: "github",
            health: "unavailable",
            last_attempt_at: new Date().toISOString(),
            last_refreshed_at: new Date(Date.now() - 4 * 60_000).toISOString(),
            error: {
              code: "unauthenticated",
              message: "GitHub rejected the sign-in.",
            },
            failing_since: new Date().toISOString(),
            retry_after: null,
            unavailable_tickets: 2,
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
  expect(screen.getByText(/Last synced 4 min ago/)).toBeTruthy();
  expect(screen.queryByText(/Last refreshed/)).toBeNull();
  expect(screen.getByText(/GitHub is unavailable/)).toBeTruthy();
  expect(screen.getByText("Connected as octo")).toBeTruthy();
  // The saved configuration is a separate fact and is not shown as healthy.
  expect(screen.getByText("Saved configuration")).toBeTruthy();
  expect(
    container.querySelector('[data-slot="status-dot"][data-tone="positive"]'),
  ).toBeNull();
});

test("discovery uses the core's imported references and Discard restores saved rules", async () => {
  vi.mocked(sourcesClient.preview).mockResolvedValue({
    ...preview,
    new: 0,
    already_here: 1,
    issues: [{ ...preview.issues[0]!, ticket: "T-142" }],
  });
  render(
    <SourceCard
      entry={{
        ...entry,
        saved: {
          provider: "github",
          config: { repositories: ["o/r"] },
          account: "octo",
          saved_at: "2026-01-01T00:00:00Z",
        },
      }}
    />,
  );
  for (const name of ["Connection", "Discovery", "Sync"])
    expect(screen.getByRole("heading", { name })).toBeTruthy();
  fireEvent.change(screen.getByLabelText(/Assignee/), {
    target: { value: "someone" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview matches" }));
  const table = await screen.findByRole("table");
  expect(
    within(table)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent),
  ).toEqual(["Issue", "Title", "In ticketd"]);
  expect(screen.getByText("0 new · 1 already here")).toBeTruthy();
  expect(table.textContent).toContain("Already T-142");
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(screen.getByLabelText(/Assignee/)).toHaveProperty("value", "");
  expect(screen.getByText("Saved configuration")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save" })).toHaveProperty(
    "disabled",
    true,
  );
});
