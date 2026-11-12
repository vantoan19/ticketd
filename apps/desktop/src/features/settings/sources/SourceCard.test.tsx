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
          help: "Issues from these repositories are discovered. Type owner/name, then press Enter.",
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

/** The status label at the end of the Discovery heading row. */
function discoveryStatus() {
  const section = screen.getByRole("region", { name: "Discovery" });
  return section.querySelector('[data-slot="status-label"]')?.textContent;
}
/** The short save state in the panel bar's end slot. */
function panelStatus() {
  return document.querySelector(".settings-panel-bar-end")?.textContent;
}
function saveBar() {
  return screen.getByRole("region", { name: "Save changes" });
}
const withLabels: SourceEntry = {
  ...entry,
  connector: {
    ...entry.connector,
    schema: {
      fields: [
        ...entry.connector.schema.fields,
        {
          key: "labels",
          label: "Labels",
          required: false,
          type: "multi_select",
          options: { source: "dynamic", depends_on: [] },
          allow_custom: true,
          min_items: 0,
          max_items: 5,
          format: null,
        },
      ],
    },
  },
};
async function addLabel(name: string) {
  const input = screen.getByRole("textbox", { name: /^Labels/ });
  fireEvent.change(input, { target: { value: name } });
  fireEvent.keyDown(input, { key: "Enter" });
  await screen.findByRole("button", { name: `Remove ${name}` });
}

/** A repository added on a connected source, ready to preview. */
async function addConnected(name: string) {
  await connect();
  await addRepository(name);
}

async function connect() {
  vi.mocked(sourcesClient.checkConnection).mockResolvedValue({
    account: "octo",
  });
  fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
  await screen.findByText("Connected as octo.");
}

async function addRepository(name: string) {
  const input = screen.getByLabelText(/Repositories/);
  fireEvent.change(input, { target: { value: name } });
  fireEvent.keyDown(input, { key: "Enter" });
  await screen.findByRole("button", { name: `Remove ${name}` });
}

test("a new source is not configured and cannot be saved before a preview", async () => {
  render(<SourceCard entry={entry} />);
  expect(discoveryStatus()).toBe("Not configured");
  const save = screen.getByRole("button", { name: "Save" });
  expect((save as HTMLButtonElement).disabled).toBe(true);
  await addRepository("o/r");
  expect(discoveryStatus()).toBe("Unsaved changes");
  expect((save as HTMLButtonElement).disabled).toBe(true);
  expect(
    screen.queryByText("Preview the matching issues before saving."),
  ).toBeNull();
});

test("Preview matches needs a repository and a connection; Refresh now needs a saved configuration", async () => {
  render(<SourceCard entry={entry} />);
  const previewButton = () =>
    screen.getByRole("button", {
      name: "Preview matches",
    }) as HTMLButtonElement;
  const refresh = screen.getByRole("button", {
    name: "Refresh now",
  }) as HTMLButtonElement;
  expect(previewButton().disabled).toBe(true);
  expect(refresh.disabled).toBe(true);
  await addRepository("o/r");
  expect(previewButton().disabled).toBe(true);
  await connect();
  expect(previewButton().disabled).toBe(false);
});

test("the repository input invites another repository once one is added", async () => {
  render(<SourceCard entry={entry} />);
  await addRepository("o/r");
  expect(screen.getByPlaceholderText("Add another repository")).toBeTruthy();
  expect(screen.getByText(/Type owner\/name, then press Enter\./)).toBeTruthy();
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
  await addConnected("o/r");
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
  expect(discoveryStatus()).toBe("Saved configuration");
});

test("editing after a preview makes the preview stale and blocks Save", async () => {
  vi.mocked(sourcesClient.preview).mockResolvedValue(preview);
  render(<SourceCard entry={entry} />);
  await addConnected("o/r");
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
  await addConnected("o/r");
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
  await addConnected("o/r");
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
  await addConnected("o/r");
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
  expect(discoveryStatus()).toBe("Saved configuration");
  expect((screen.getByLabelText(/Assignee/) as HTMLInputElement).value).toBe(
    "octo",
  );
  fireEvent.change(screen.getByLabelText(/Assignee/), {
    target: { value: "someone" },
  });
  expect(discoveryStatus()).toBe("Unsaved changes");
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
  expect(screen.queryByRole("button", { name: "GitHub" })).toBeNull();
  unmount();

  vi.mocked(sourcesClient.list).mockResolvedValue([entry]);
  render(<SettingsNav onBack={() => {}} />);
  const group = await screen.findByRole("group", { name: "Connections" });
  expect(group.textContent).toContain("Google Drive");
  expect(group.textContent).toContain("GitHub");
});

test("opening a source focuses its page title, named for the source", async () => {
  vi.mocked(sourcesClient.list).mockResolvedValue([entry]);
  const props = { onRestore: async () => {}, onOpenInbox: () => {} };
  const { rerender } = render(
    <SettingsView {...props} selected="appearance" />,
  );
  await screen.findByRole("heading", { level: 1, name: "Appearance" });
  rerender(<SettingsView {...props} selected="source-github" />);
  expect(document.activeElement).toBe(
    screen.getByRole("heading", { level: 1, name: "GitHub" }),
  );
});

test("switching settings sections retains the source draft and its preview", async () => {
  vi.mocked(sourcesClient.list).mockResolvedValue([entry]);
  vi.mocked(sourcesClient.preview).mockResolvedValue(preview);
  const props = { onRestore: async () => {}, onOpenInbox: () => {} };
  const { rerender, unmount } = render(
    <SettingsView {...props} selected="source-github" />,
  );
  await screen.findByRole("heading", { name: "Discovery" });
  await addConnected("o/r");
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
  expect(discoveryStatus()).toBe("Saved configuration");
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
  expect(discoveryStatus()).toBe("Saved configuration");
  expect(
    container.querySelector('[data-slot="status-dot"][data-tone="positive"]'),
  ).toBeNull();
});

test("discovery uses the core's imported references and Discard restores saved rules", async () => {
  vi.mocked(sourcesClient.preview).mockResolvedValue({
    ...preview,
    new: 0,
    already_here: 1,
    issues: [{ ...preview.issues[0]!, ticket: "T-KQ142" }],
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
  expect(table.textContent).toContain("Already T-KQ142");
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(screen.getByLabelText(/Assignee/)).toHaveProperty("value", "");
  expect(discoveryStatus()).toBe("Saved configuration");
  expect(screen.getByRole("button", { name: "Save" })).toHaveProperty(
    "disabled",
    true,
  );
});

test("optional fields show grey examples and an Optional marker, not saved-looking values", () => {
  render(<SourceCard entry={entry} />);
  expect(screen.getByPlaceholderText("e.g. acme/billing-api")).toBeTruthy();
  expect(screen.getByPlaceholderText("e.g. octocat")).toBeTruthy();
  expect(screen.queryByPlaceholderText("Anyone")).toBeNull();
  expect(screen.getAllByText("Optional").length).toBeGreaterThan(0);
});

test("the section list puts Connections after Agents and before Help", async () => {
  vi.mocked(sourcesClient.list).mockResolvedValue([entry]);
  render(<SettingsNav onBack={() => {}} />);
  await screen.findByRole("group", { name: "Connections" });
  const groups = screen
    .getAllByRole("group")
    .map((group) => group.getAttribute("aria-label"));
  expect(groups).toEqual([
    "Preferences",
    "Workspace",
    "Agents",
    "Connections",
    "Help",
  ]);
});

test("the panel bar and the save bar follow the draft: not configured, unsaved, ready to save, saved", async () => {
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
  expect(panelStatus()).toBe("Not configured");
  expect(saveBar().textContent).toContain("Not configured. Add a repository");

  await addConnected("o/r");
  expect(panelStatus()).toBe("Unsaved changes");
  expect(saveBar().textContent).toContain(
    "Unsaved changes. Preview the matching issues before saving.",
  );

  fireEvent.click(
    within(saveBar()).getByRole("button", { name: "Preview matches" }),
  );
  await screen.findByRole("region", { name: "Preview" });
  expect(panelStatus()).toBe("Ready to save");
  expect(saveBar().textContent).toContain("Preview is current.");
  // The preview is current, so the button that makes one goes away.
  expect(
    within(saveBar()).queryByRole("button", { name: "Preview matches" }),
  ).toBeNull();

  fireEvent.click(within(saveBar()).getByRole("button", { name: "Save" }));
  await screen.findByText(/Matching issues are imported on the next refresh/);
  expect(panelStatus()).toBe("Saved configuration");
  expect(saveBar().textContent).toContain("saved");
  expect(
    within(saveBar())
      .getByRole("button", { name: "Discard changes" })
      .hasAttribute("disabled"),
  ).toBe(true);
});

test("the save actions live in the save bar, not in the Discovery section", () => {
  render(<SourceCard entry={entry} />);
  const discovery = screen.getByRole("region", { name: "Discovery" });
  for (const name of ["Save", "Discard changes", "Preview matches"]) {
    expect(within(saveBar()).getByRole("button", { name })).toBeTruthy();
    expect(within(discovery).queryByRole("button", { name })).toBeNull();
  }
});

test("GitHub reads the draft back as one sentence", async () => {
  render(<SourceCard entry={withLabels} />);
  const readback = () => screen.getByTestId("source-readback").textContent;
  expect(readback()).toBe(
    "Imports open issues from no repository yet, assigned to anyone.",
  );
  await addRepository("o/r");
  expect(readback()).toBe("Imports open issues from o/r, assigned to anyone.");
  await addLabel("bug");
  expect(readback()).toBe(
    "Imports open issues from o/r that have the label bug, assigned to anyone.",
  );
  await addLabel("urgent");
  fireEvent.change(screen.getByLabelText(/Assignee/), {
    target: { value: "octo" },
  });
  expect(readback()).toBe(
    "Imports open issues from o/r that have the labels bug and urgent, assigned to octo.",
  );
});

test("another source shows no readback sentence", () => {
  render(
    <SourceCard
      entry={{
        ...entry,
        connector: { ...entry.connector, provider: "gitlab", name: "GitLab" },
      }}
    />,
  );
  expect(screen.queryByTestId("source-readback")).toBeNull();
});

test("the Sync section shows the refresh command with a copy button", () => {
  render(<SourceCard entry={entry} />);
  const sync = screen.getByRole("region", { name: "Sync" });
  expect(sync.textContent).toContain(
    "Agents can refresh without the desktop open",
  );
  expect(sync.textContent).toContain("ticketd source refresh");
  expect(
    within(sync).getByRole("button", { name: "Copy refresh command" }),
  ).toBeTruthy();
  expect(
    within(sync).getByRole("button", { name: "Refresh now" }),
  ).toBeTruthy();
});

test("a failed preview is announced beside the Discovery fields and keeps the save bar usable", async () => {
  vi.mocked(sourcesClient.preview).mockRejectedValue(
    new SourceFailure("unauthenticated", "GitHub rejected the credential"),
  );
  render(<SourceCard entry={entry} />);
  await addConnected("o/r");
  fireEvent.click(
    within(saveBar()).getByRole("button", { name: "Preview matches" }),
  );
  const alert = await screen.findByRole("alert");
  expect(
    within(screen.getByRole("region", { name: "Discovery" })).getByRole(
      "alert",
    ),
  ).toBe(alert);
  expect(panelStatus()).toBe("Unsaved changes");
});
