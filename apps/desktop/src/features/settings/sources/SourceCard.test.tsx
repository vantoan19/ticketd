// @vitest-environment jsdom
import { githubSource } from "@/test/source-fixtures";
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
import { SourcesPage } from "@/features/settings/pages/SourcesPage";
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
    configurationSummary: vi.fn(),
    options: vi.fn(),
    preview: vi.fn(),
    save: vi.fn(),
    add: vi.fn(),
    signIn: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
    refresh: vi.fn(),
    cancelRefresh: vi.fn(),
  },
}));

const entry: SourceEntry = {
  connector: {
    ...githubSource.connector,
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
      label: "r#1",
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
  vi.mocked(sourcesClient.configurationSummary).mockResolvedValue([]);
  vi.mocked(sourcesClient.checkConnection).mockResolvedValue({
    account: "octo",
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

/** The short save state in the panel bar's end slot: the rules' one label. */
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

async function addRepository(name: string) {
  const input = screen.getByLabelText(/Repositories/);
  fireEvent.change(input, { target: { value: name } });
  fireEvent.keyDown(input, { key: "Enter" });
  await screen.findByRole("button", { name: `Remove ${name}` });
}

test("a new source is not configured and cannot be saved before a preview", async () => {
  render(<SourceCard entry={entry} />);
  expect(panelStatus()).toBe("Not configured");
  const save = screen.getByRole("button", { name: "Save" });
  expect((save as HTMLButtonElement).disabled).toBe(true);
  await addRepository("o/r");
  expect(panelStatus()).toBe("Unsaved changes");
  expect((save as HTMLButtonElement).disabled).toBe(true);
  expect(
    screen.queryByText("Preview the matching issues before saving."),
  ).toBeNull();
});

test("Preview matches needs a repository; Sync now needs a saved configuration", async () => {
  render(<SourceCard entry={entry} />);
  const previewButton = () =>
    screen.getByRole("button", {
      name: "Preview matches",
    }) as HTMLButtonElement;
  const refresh = screen.getByRole("button", {
    name: "Sync now",
  }) as HTMLButtonElement;
  expect(previewButton().disabled).toBe(true);
  expect(refresh.disabled).toBe(true);
  await addRepository("o/r");
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
  await addRepository("o/r");
  fireEvent.click(screen.getByRole("button", { name: "Preview matches" }));
  const panel = await screen.findByRole("region", { name: "Preview" });
  expect(panel.textContent).toContain("1 issue matches");
  expect(panel.textContent).toContain("First issue");
  expect(panel.textContent).toContain("nothing has been imported");
  expect(sourcesClient.preview).toHaveBeenCalledWith(
    "github",
    { repositories: ["o/r"] },
    undefined,
  );

  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText(/Matching issues are imported on the next sync/);
  expect(sourcesClient.save).toHaveBeenCalledWith(
    "github",
    { repositories: ["o/r"] },
    undefined,
  );
  expect(panelStatus()).toBe("Saved configuration");
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
    "The account needs to be connected again.",
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

test("conditional settings, advanced fields and setup links use the source schema", async () => {
  const richer: SourceEntry = {
    ...entry,
    connector: {
      ...entry.connector,
      schema: {
        fields: [
          ...entry.connector.schema.fields,
          { key: "site", label: "Site", type: "text", required: false },
          {
            key: "project",
            label: "Project key",
            type: "text",
            show_if: "site",
            advanced: true,
            required: true,
            placeholder: "ENG-1",
            help: "Use the key from the project settings.",
            pattern: {
              regex: "^ENG-[0-9]+$",
              message: "must use an engineering key",
            },
          },
          {
            key: "setup",
            label: "Set up the connection",
            required: false,
            type: "link",
            url: "https://example.com/setup",
          },
          {
            key: "unsafe",
            label: "Unsafe link",
            required: false,
            type: "link",
            url: "http://example.com/setup",
          },
          {
            key: "unbound",
            label: "Unbound link",
            required: false,
            type: "link",
            url: "https:example.com/setup",
          },
        ],
      },
    },
  };
  vi.mocked(sourcesClient.preview).mockRejectedValue({
    code: "invalid_configuration",
    message: "configuration invalid",
    fields: [
      { message: "This account and site cannot be used together." },
      { field: "project", message: "must use an engineering key" },
    ],
  });
  render(<SourceCard entry={richer} />);
  expect(
    screen
      .getByRole("link", { name: "Set up the connection" })
      .getAttribute("href"),
  ).toBe("https://example.com/setup");
  expect(screen.queryByRole("link", { name: "Unsafe link" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Unbound link" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Project key" })).toBeNull();

  await addRepository("o/r");
  fireEvent.change(screen.getByLabelText(/Site/), {
    target: { value: "example" },
  });
  expect(screen.queryByRole("textbox", { name: "Project key" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Advanced settings" }));
  const project = screen.getByLabelText(/Project key/);
  expect(project.getAttribute("placeholder")).toBe("ENG-1");
  expect(project.getAttribute("aria-required")).toBe("true");
  expect(
    screen.getByText("Use the key from the project settings."),
  ).toBeTruthy();
  fireEvent.change(project, { target: { value: "bad" } });
  fireEvent.click(screen.getByRole("button", { name: "Advanced settings" }));
  fireEvent.click(screen.getByRole("button", { name: "Preview matches" }));
  await screen.findByText("This account and site cannot be used together.");
  expect(
    screen.getByText("Project key must use an engineering key"),
  ).toBeTruthy();
  expect(
    screen.getByLabelText(/Project key/).getAttribute("aria-invalid"),
  ).toBe("true");

  fireEvent.change(screen.getByLabelText(/Site/), { target: { value: "" } });
  expect(screen.queryByRole("textbox", { name: "Project key" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Preview matches" }));
  expect(sourcesClient.preview).toHaveBeenLastCalledWith(
    "github",
    { repositories: ["o/r"] },
    undefined,
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
  expect(panelStatus()).toBe("Saved configuration");
  expect((screen.getByLabelText(/Assignee/) as HTMLInputElement).value).toBe(
    "octo",
  );
  fireEvent.change(screen.getByLabelText(/Assignee/), {
    target: { value: "someone" },
  });
  expect(panelStatus()).toBe("Unsaved changes");
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
    undefined,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add o/alpha" }));
  expect(screen.getByRole("button", { name: "Remove o/alpha" })).toBeTruthy();
});

test("the account is checked once on opening, apart from the saved rules", async () => {
  render(<SourceCard entry={entry} />);
  // Signed in, but no rules are saved: the workspace is not connected yet.
  await screen.findByText("Signed in as octo");
  expect(screen.getByText("Not connected")).toBeTruthy();
  expect(sourcesClient.checkConnection).toHaveBeenCalledTimes(1);
  vi.mocked(sourcesClient.checkConnection).mockRejectedValue(
    new SourceFailure("unauthenticated", "GitHub rejected the credential"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
  await screen.findByText("Not signed in to GitHub");
  expect(screen.queryByText(/rejected the credential/)).toBeNull();
});

test("a hidden source page does not check the account until it is shown", async () => {
  const { rerender } = render(<SourceCard entry={entry} hidden />);
  await act(async () => {});
  expect(sourcesClient.checkConnection).not.toHaveBeenCalled();
  rerender(<SourceCard entry={entry} />);
  await screen.findByText("Signed in as octo");
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
  expect(
    await within(group).findByRole("button", { name: "GitHub" }),
  ).toBeTruthy();
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
  expect(screen.getByText(/Synced 4 min ago/)).toBeTruthy();
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
  expect(panelStatus()).toBe("Saved configuration");
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
  expect(screen.queryByText(/^Synced/)).toBeNull();
  expect(screen.getByText(/GitHub is unavailable/)).toBeTruthy();
  expect(screen.getByText("Connected as octo")).toBeTruthy();
  // The saved configuration is a separate fact and is not shown as healthy.
  expect(panelStatus()).toBe("Saved configuration");
  expect(
    container.querySelector('[data-slot="status-dot"][data-tone="positive"]'),
  ).toBeNull();
});

test("a saved source without a credential shows one row that says how to sign in", async () => {
  vi.mocked(sourcesClient.checkConnection).mockRejectedValue(
    new SourceFailure("unauthenticated", "no GitHub credential found"),
  );
  render(
    <SourceActivityContext.Provider
      value={{
        refreshing: false,
        sources: [
          {
            provider: "github",
            health: "unavailable",
            last_attempt_at: new Date().toISOString(),
            last_refreshed_at: null,
            error: {
              code: "unauthenticated",
              message: "no GitHub credential found",
            },
            failing_since: new Date().toISOString(),
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
  await screen.findByText("Not signed in to GitHub");
  expect(
    screen.getByText(
      "Run “gh auth login” in a terminal, then choose Check connection.",
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/needs to be connected again/)).toBeNull();
  // The same cause is not told a second time, nor does the first row claim a connection.
  expect(screen.queryByText(/GitHub is unavailable/)).toBeNull();
  expect(screen.queryByText("Connected as octo")).toBeNull();
  expect(screen.getByText("Saved for octo")).toBeTruthy();
});

test("Needs sign-in opens only active credential fields and saves a replacement", async () => {
  const saved = {
    id: "credential-example",
    provider: "github",
    config: { repositories: ["o/r"] },
    account: "octo",
    saved_at: "2026-02-01T00:00:00Z",
    secret_fields: ["api_key"],
  };
  vi.mocked(sourcesClient.checkConnection).mockRejectedValue(
    new SourceFailure("unauthenticated", "The tracker rejected the key"),
  );
  vi.mocked(sourcesClient.signIn).mockResolvedValue({
    ...saved,
    session_secret_fields: ["api_key"],
  });
  render(
    <SourceCard
      entry={{
        ...entry,
        connector: {
          ...entry.connector,
          schema: {
            fields: [
              ...entry.connector.schema.fields,
              {
                key: "api_key",
                label: "API key",
                required: true,
                type: "secret",
              },
              {
                key: "conditional_key",
                label: "Conditional credential",
                required: false,
                type: "secret",
                show_if: "assignee",
              },
            ],
          },
        },
        saved,
      }}
    />,
  );
  await screen.findByText("Needs sign-in");
  fireEvent.click(screen.getByRole("button", { name: "Re-enter credentials" }));
  const dialog = within(
    screen.getByRole("dialog", { name: "Re-enter credentials" }),
  );
  const input = dialog.getByLabelText(/API key/);
  expect(input.getAttribute("type")).toBe("password");
  expect(input.getAttribute("value")).toBe("");
  expect(
    dialog.queryByLabelText(/Repositories|Conditional credential/),
  ).toBeNull();
  fireEvent.change(input, {
    target: { value: "synthetic replacing credential" },
  });
  fireEvent.click(dialog.getByRole("button", { name: "Save credentials" }));
  await screen.findByText(/credentials last until ticketd closes/);
  expect(sourcesClient.signIn).toHaveBeenCalledWith("credential-example", {
    api_key: "synthetic replacing credential",
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByText("Needs sign-in")).toBeNull();
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
  expect(panelStatus()).toBe("Saved configuration");
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

  await addRepository("o/r");
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
  await screen.findByText(/Matching issues are imported on the next sync/);
  expect(panelStatus()).toBe("Saved configuration");
  expect(saveBar().textContent).toMatch(/saved/i);
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

test("the connector's readback follows draft changes and preserves emphasis", async () => {
  vi.mocked(sourcesClient.configurationSummary)
    .mockResolvedValueOnce([{ text: "No repositories yet.", emphasis: false }])
    .mockResolvedValueOnce([
      { text: "Imports open issues from ", emphasis: false },
      { text: "o/r", emphasis: true },
      { text: ".", emphasis: false },
    ])
    .mockResolvedValueOnce([
      { text: "Imports open issues from o/r with bug.", emphasis: false },
    ]);
  render(<SourceCard entry={withLabels} />);
  expect(await screen.findByText("No repositories yet.")).toBeTruthy();
  await addRepository("o/r");
  const summary = await screen.findByTestId("source-readback");
  expect(summary.textContent).toBe("Imports open issues from o/r.");
  expect(within(summary).getByText("o/r").tagName).toBe("STRONG");
  expect(sourcesClient.configurationSummary).toHaveBeenLastCalledWith(
    "github",
    { repositories: ["o/r"] },
  );
  await addLabel("bug");
  expect(
    await screen.findByText("Imports open issues from o/r with bug."),
  ).toBeTruthy();
  expect(sourcesClient.configurationSummary).toHaveBeenLastCalledWith(
    "github",
    { repositories: ["o/r"], labels: ["bug"] },
  );
});

test("the Sync section shows the saved connection's refresh command with a copy button", () => {
  render(
    <SourceCard
      entry={{
        ...entry,
        saved: {
          id: "github-2",
          provider: "github",
          config: { repositories: ["o/r"] },
          account: "octo",
          saved_at: "2026-02-01T00:00:00Z",
        },
      }}
    />,
  );
  const sync = screen.getByRole("region", { name: "Sync" });
  expect(sync.textContent).toContain(
    "Agents can sync without the desktop open",
  );
  expect(sync.textContent).toContain("ticketd source github-2 refresh");
  expect(
    within(sync).getByRole("button", { name: "Copy sync command" }),
  ).toBeTruthy();
  expect(within(sync).getByRole("button", { name: "Sync now" })).toBeTruthy();
});

test("Sync now reports progress and cancels its own refresh", async () => {
  let rejectRefresh: (error: SourceFailure) => void = () => {};
  vi.mocked(sourcesClient.refresh).mockImplementation(
    (_ticket, _connection, _retry, control) =>
      new Promise((_resolve, reject) => {
        rejectRefresh = reject;
        control?.update({ kind: "started" });
        control?.update({ kind: "progress", completed: 12, total: 30 });
      }),
  );
  vi.mocked(sourcesClient.cancelRefresh).mockResolvedValue(true);
  render(
    <SourceCard
      entry={{
        ...entry,
        connector: { ...entry.connector, provider: "example", name: "Example" },
        saved: {
          id: "example-2",
          provider: "example",
          config: { repositories: ["o/r"] },
          account: "octo",
          saved_at: "2026-02-01T00:00:00Z",
        },
      }}
    />,
  );
  const sync = within(screen.getByRole("region", { name: "Sync" }));
  fireEvent.click(sync.getByRole("button", { name: "Sync now" }));
  expect(await sync.findByText(/12 of 30/)).toBeTruthy();
  fireEvent.click(sync.getByRole("button", { name: "Cancel sync" }));
  const [, id, , control] = vi.mocked(sourcesClient.refresh).mock.calls[0]!;
  expect(id).toBe("example-2");
  expect(sourcesClient.cancelRefresh).toHaveBeenCalledWith(control?.id);
  await act(async () => {
    rejectRefresh(
      new SourceFailure("refresh_canceled", "source refresh canceled"),
    );
  });
  expect(sync.getByText("Sync canceled")).toBeTruthy();
  expect(sync.getByRole("button", { name: "Sync now" })).toBeTruthy();
});

test("a failed preview is said in the save bar, beside its actions, with no summary in the form", async () => {
  vi.mocked(sourcesClient.preview).mockRejectedValue(
    new SourceFailure("unauthenticated", "GitHub rejected the credential"),
  );
  render(<SourceCard entry={entry} />);
  await addRepository("o/r");
  fireEvent.click(
    within(saveBar()).getByRole("button", { name: "Preview matches" }),
  );
  const alert = await within(saveBar()).findByRole("alert");
  expect(alert.textContent).toContain("Couldn't preview matching issues");
  expect(
    within(screen.getByRole("region", { name: "Discovery" })).queryByRole(
      "alert",
    ),
  ).toBeNull();
  expect(panelStatus()).toBe("Unsaved changes");
});

test("Sources adds a named connection and renames it without changing its ID", async () => {
  vi.mocked(sourcesClient.list).mockResolvedValue([
    { ...entry, next_id: "github-2" },
  ]);
  vi.mocked(sourcesClient.preview).mockResolvedValue(preview);
  const created = {
    id: "github-2",
    name: "Work",
    provider: "github",
    account: "octo",
    config: { repositories: ["o/r"] },
    saved_at: "2026-01-01T00:00:00Z",
  };
  vi.mocked(sourcesClient.add).mockResolvedValue({ source: created, preview });
  vi.mocked(sourcesClient.rename).mockResolvedValue({
    ...created,
    name: "Work issues",
  });
  render(<SourcesPage onOpen={vi.fn()} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Add GitHub connection" }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Connection name" }), {
    target: { value: "Work" },
  });
  await addRepository("o/r");
  fireEvent.click(screen.getByRole("button", { name: "Preview matches" }));
  await screen.findByRole("region", { name: "Preview" });
  fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
  expect(sourcesClient.add).toHaveBeenCalledWith("github", "github-2", "Work", {
    repositories: ["o/r"],
  });
  fireEvent.click(await screen.findByRole("button", { name: "Rename Work" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Connection name" }), {
    target: { value: "Work issues" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));
  await screen.findByText("Work issues");
  expect(sourcesClient.rename).toHaveBeenCalledWith("github-2", "Work issues");
  expect(screen.getByText(/github-2/)).toBeTruthy();
});

test("removing a connection needs confirmation and removes only that connection", async () => {
  const saved = {
    provider: "github",
    account: "octo",
    config: { repositories: ["o/r"] },
    saved_at: "2026-01-01T00:00:00Z",
  };
  vi.mocked(sourcesClient.list).mockResolvedValue([
    {
      ...githubSource,
      saved: { ...saved, id: "github", name: "Work" },
    },
    {
      ...githubSource,
      saved: { ...saved, id: "github-2", name: "Personal" },
    },
  ]);
  vi.mocked(sourcesClient.remove).mockResolvedValue(undefined);
  const onChanged = vi.fn(async () => {});
  render(<SourcesPage onOpen={vi.fn()} onChanged={onChanged} />);
  const remove = await screen.findByRole("button", { name: "Remove Work" });
  fireEvent.click(remove);
  const dialog = screen.getByRole("dialog", { name: "Remove Work?" });
  expect(
    within(dialog).getByText(/last synced content, local work/),
  ).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(sourcesClient.remove).not.toHaveBeenCalled();

  fireEvent.click(remove);
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "Remove Work?" })).getByRole(
      "button",
      { name: "Remove connection" },
    ),
  );
  await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  expect(sourcesClient.remove).toHaveBeenCalledExactlyOnceWith("github");
  expect(screen.queryByRole("button", { name: "Remove Work" })).toBeNull();
  expect(screen.getByRole("button", { name: "Remove Personal" })).toBeTruthy();
});
