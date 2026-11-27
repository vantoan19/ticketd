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
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ConnectProjectSource } from "@/features/projects/ConnectProjectSource";
import { SourceCard } from "@/features/settings/sources/SourceCard";
import { SettingsNav } from "@/features/settings/SettingsNav";
import { SettingsView } from "@/features/settings/SettingsView";
import { workspaceClient } from "@/lib/api/workspace";
import { SourceActivityContext } from "@/features/tickets/source-activity";
import {
  SourceFailure,
  sourcesClient,
  type DiscoveryPreview,
  type SourceEntry,
  type SourceStatus,
} from "@/lib/api/sources";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

Element.prototype.scrollIntoView ??= () => {};

vi.mock("@/lib/api/sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/sources")>()),
  sourcesClient: {
    list: vi.fn(),
    checkConnection: vi.fn(),
    configurationSummary: vi.fn(),
    repositoryRoutes: vi.fn(),
    projectSourceCandidates: vi.fn(),
    previewConnectSource: vi.fn(),
    connectSource: vi.fn(),
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

const savedRepositories: SourceEntry = {
  ...entry,
  saved: {
    id: "github-2",
    name: "Backend source",
    provider: "github",
    config: { repositories: ["o/r", "other/repo"] },
    account: "octo",
    saved_at: "2026-01-01T00:00:00Z",
  },
};

const repositoryRoutes = [
  {
    repository: "o/r",
    project_remote: "github.example/o/r",
    project: { id: "p1", name: "Desktop" },
    archived_project_name: null,
  },
  {
    repository: "other/repo",
    project_remote: "github.example/other/repo",
    project: null,
    archived_project_name: null,
  },
];

test("the project column shows saved repository routes while editing discovery", async () => {
  vi.mocked(sourcesClient.repositoryRoutes).mockResolvedValue(repositoryRoutes);
  render(<SourceCard entry={savedRepositories} />);

  const table = await screen.findByRole("table", {
    name: "Saved repository routes",
  });
  expect(sourcesClient.repositoryRoutes).toHaveBeenCalledWith("github-2");
  expect(
    within(table).getByRole("columnheader", { name: "Project" }),
  ).toBeTruthy();
  expect(
    within(table).getByRole("row", { name: /o\/r.*Desktop/ }),
  ).toBeTruthy();
  const unlinked = within(table).getByRole("row", {
    name: /other\/repo.*No project/,
  });
  expect(
    within(unlinked).getByRole("button", { name: /Link to project/ }),
  ).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Remove o/r" }));
  await addRepository("draft/new");
  expect(within(table).getByText("o/r")).toBeTruthy();
  expect(within(table).queryByText("draft/new")).toBeNull();
});

test("an archived repository claim previews No project and cannot be relinked", async () => {
  vi.mocked(sourcesClient.repositoryRoutes).mockResolvedValue([
    {
      ...repositoryRoutes[0]!,
      project: null,
      archived_project_name: "Desktop",
    },
  ]);
  render(<SourceCard entry={savedRepositories} />);

  const table = await screen.findByRole("table", {
    name: "Saved repository routes",
  });
  const row = within(table).getByRole("row", { name: /o\/r/ });
  expect(within(row).getByText("No project")).toBeTruthy();
  expect(within(row).getByText("Desktop is archived")).toBeTruthy();
  expect(
    within(row).queryByRole("button", { name: /Link to project/ }),
  ).toBeNull();
});

function SourceCardWithProjectReview() {
  const [review, setReview] = useState<{
    projectId: string;
    connection: string;
  } | null>(null);
  return (
    <>
      <SourceCard
        entry={savedRepositories}
        onProjectLinked={(projectId, connection) =>
          setReview({ projectId, connection })
        }
      />
      {review && (
        <ConnectProjectSource
          {...review}
          onClose={() => setReview(null)}
          onSetup={() => {}}
          onConnected={() => {}}
        />
      )}
    </>
  );
}

test("linking offers active unclaimed projects and then reviews only backfill", async () => {
  const linked = {
    id: "p2",
    name: "Backend",
    path: "/checkout",
    paths: ["/checkout"],
    remote: "github.example/other/repo",
  };
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_projects")
      return [
        { ...linked, remote: null },
        { ...linked, id: "p1", name: "Already claimed" },
        { ...linked, id: "p3", name: "Archived", remote: null, archived: true },
      ];
    if (command === "link_source_repository_project") {
      vi.mocked(sourcesClient.repositoryRoutes).mockResolvedValue([
        repositoryRoutes[0]!,
        {
          ...repositoryRoutes[1]!,
          project: { id: linked.id, name: linked.name },
        },
      ]);
      return linked;
    }
    throw new Error(`Unexpected command ${command}`);
  });
  vi.mocked(sourcesClient.repositoryRoutes).mockResolvedValue(repositoryRoutes);
  vi.mocked(sourcesClient.previewConnectSource).mockResolvedValue({
    provider: "github",
    connection_id: "github-2",
    project_id: linked.id,
    repository: "other/repo",
    project_remote: linked.remote,
    source: "already_listed",
    tickets: ["T-KQ142"],
    fingerprint: "reviewed",
  });
  vi.mocked(sourcesClient.connectSource).mockResolvedValue({
    repository_added: false,
    linked_tickets: ["T-KQ142"],
  });
  render(<SourceCardWithProjectReview />);

  fireEvent.click(
    await screen.findByRole("button", {
      name: "Link to project for other/repo",
    }),
  );
  const picker = await screen.findByRole("combobox", { name: "Project" });
  fireEvent.keyDown(picker, { key: "Enter" });
  const backend = await screen.findByRole("option", { name: "Backend" });
  expect(screen.queryByRole("option", { name: "Already claimed" })).toBeNull();
  expect(screen.queryByRole("option", { name: "Archived" })).toBeNull();
  fireEvent.click(backend);
  fireEvent.click(screen.getByRole("button", { name: "Link project" }));

  const review = await screen.findByRole("dialog", {
    name: "Connect project to Backend source",
  });
  expect(
    await within(review).findByText("Link 1 existing ticket"),
  ).toBeTruthy();
  expect(within(review).queryByText(/Import issues/)).toBeNull();
  fireEvent.click(within(review).getByRole("button", { name: "Confirm" }));
  expect(
    await screen.findByRole("row", { name: /other\/repo.*Backend/ }),
  ).toBeTruthy();
  expect(sourcesClient.connectSource).toHaveBeenCalledWith(
    "github-2",
    "p2",
    "reviewed",
  );
  expect(invoke).toHaveBeenCalledWith("link_source_repository_project", {
    connection: "github-2",
    repository: "other/repo",
    projectId: "p2",
  });
});

test("create project chooses a checkout and uses the saved repository as the Project remote", async () => {
  const created = {
    id: "p3",
    name: "Web Checkout",
    path: "/work/Web checkout",
    paths: ["/work/Web checkout"],
    remote: "github.example/other/repo",
  };
  vi.spyOn(workspaceClient, "chooseFolder").mockResolvedValue(created.path);
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_projects") return [];
    if (command === "create_source_repository_project") return created;
    throw new Error(`Unexpected command ${command}`);
  });
  vi.mocked(sourcesClient.repositoryRoutes).mockResolvedValue(repositoryRoutes);
  vi.mocked(sourcesClient.previewConnectSource).mockResolvedValue({
    provider: "github",
    connection_id: "github-2",
    project_id: created.id,
    repository: "other/repo",
    project_remote: created.remote,
    source: "already_listed",
    tickets: [],
    fingerprint: "reviewed",
  });
  render(<SourceCardWithProjectReview />);

  fireEvent.click(
    await screen.findByRole("button", {
      name: "Link to project for other/repo",
    }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Create project…" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "New project" });
  expect(within(dialog).getByLabelText("Project remote")).toHaveProperty(
    "value",
    created.remote,
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Choose…" }));
  await within(dialog).findByDisplayValue(created.name);
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Create project" }),
  );

  expect(await screen.findByText("No existing tickets to link.")).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("create_source_repository_project", {
    connection: "github-2",
    repository: "other/repo",
    name: created.name,
    path: created.path,
  });
});

test("creating from a stale route asks the person to reload saved repositories", async () => {
  vi.spyOn(workspaceClient, "chooseFolder").mockResolvedValue("/work/checkout");
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_projects") return [];
    if (command === "create_source_repository_project") {
      vi.mocked(sourcesClient.repositoryRoutes).mockResolvedValue(
        repositoryRoutes.slice(0, 1),
      );
      throw {
        code: "source_repository_not_listed",
        message:
          "other/repo is no longer in the saved discovery repositories. Reload the routes and choose a saved repository.",
      };
    }
    throw new Error(`Unexpected command ${command}`);
  });
  vi.mocked(sourcesClient.repositoryRoutes).mockResolvedValue(repositoryRoutes);
  render(<SourceCardWithProjectReview />);

  fireEvent.click(
    await screen.findByRole("button", {
      name: "Link to project for other/repo",
    }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Create project…" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "New project" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Choose…" }));
  await within(dialog).findByDisplayValue("Checkout");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Create project" }),
  );
  const reload = await within(dialog).findByRole("button", {
    name: "Reload repository routes",
  });
  expect(within(dialog).getByRole("alert").textContent).toContain(
    "Other/repo is no longer in the saved discovery repositories",
  );
  fireEvent.click(reload);

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Link to project for other/repo" }),
    ).toBeNull(),
  );
  expect(sourcesClient.previewConnectSource).not.toHaveBeenCalled();
});

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
  vi.mocked(sourcesClient.repositoryRoutes).mockResolvedValue([]);
  vi.mocked(sourcesClient.projectSourceCandidates).mockResolvedValue([
    {
      source: "github",
      provider: "github",
      connection_id: "github",
      name: "Other source",
    },
    {
      source: "github-2",
      provider: "github",
      connection_id: "github-2",
      name: "Backend source",
    },
  ]);
  vi.mocked(sourcesClient.checkConnection).mockResolvedValue({
    account: "octo",
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.mocked(invoke).mockReset();
  vi.restoreAllMocks();
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
  const input = screen.getByRole("textbox", { name: /^Repositories/ });
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

test("a connection check that needs required settings shows the field to complete", async () => {
  vi.mocked(sourcesClient.checkConnection).mockRejectedValueOnce(
    new SourceFailure(
      "invalid_configuration",
      "settings are incomplete",
      null,
      [{ field: "repositories", message: "are required for this check" }],
    ),
  );
  render(<SourceCard entry={entry} />);
  await screen.findByText("Connection settings need attention");
  expect(
    screen.getByText("Repositories are required for this check"),
  ).toBeTruthy();

  await addRepository("o/r");
  expect(
    screen.queryByText("Repositories are required for this check"),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
  await screen.findByText("Signed in as octo");
});

test("a hidden source page does not check the account until it is shown", async () => {
  const { rerender } = render(<SourceCard entry={entry} hidden />);
  await act(async () => {});
  expect(sourcesClient.checkConnection).not.toHaveBeenCalled();
  rerender(<SourceCard entry={entry} />);
  await screen.findByText("Signed in as octo");
});

test("the section list has no entry for a connection, available or saved", async () => {
  vi.mocked(sourcesClient.list).mockResolvedValue([entry]);
  render(<SettingsNav onBack={() => {}} />);
  const group = await screen.findByRole("group", { name: "Connections" });
  expect(
    within(group)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Ticket sources"]);
  expect(screen.queryByRole("button", { name: "GitHub" })).toBeNull();
});

test("opening a source focuses its page title, named for the source", async () => {
  vi.mocked(sourcesClient.list).mockResolvedValue([entry]);
  const props = { onRestore: async () => {} };
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
  const props = { onRestore: async () => {} };
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
      <SettingsView selected={selected} onRestore={async () => {}} />
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

test("credential replacement stays signed in through an unavailable health read", async () => {
  const saved = {
    id: "credential-example",
    provider: "github",
    config: { repositories: ["o/r"] },
    account: "octo",
    saved_at: "2026-02-01T00:00:00Z",
    secret_fields: ["api_key"],
  };
  let rejectCheck: (error: SourceFailure) => void = () => {};
  vi.mocked(sourcesClient.checkConnection).mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectCheck = reject;
      }),
  );
  vi.mocked(sourcesClient.signIn).mockResolvedValue({
    ...saved,
    session_secret_fields: ["api_key"],
  });
  const failedHealth: SourceStatus = {
    provider: saved.provider,
    connection_id: saved.id,
    health: "unavailable",
    last_attempt_at: null,
    last_refreshed_at: null,
    error: {
      code: "unauthenticated",
      message: "The tracker rejected the key",
    },
    failing_since: null,
    retry_after: null,
    unavailable_tickets: 0,
    partial_message: null,
  };
  const readHealth = vi
    .fn(async () => {})
    .mockRejectedValueOnce(new Error("Health read failed"));
  function Fixture() {
    const [shown, setShown] = useState(true);
    const [verifiedCredentials, setVerifiedCredentials] = useState(
      new Map<string, { account: string; read: number }>(),
    );
    const [failure, setFailure] = useState(0);
    return (
      <SourceActivityContext.Provider
        value={{
          refreshing: false,
          sources: [failedHealth],
          entries: null,
          intervalSecs: 300,
          openSettings: () => {},
          refreshAll: async () => {},
          verifiedCredentials,
          healthReadFailure: failure,
          readHealth: (verified) => {
            const generation = readHealth.mock.calls.length + 2;
            if (verified)
              setVerifiedCredentials(
                new Map([
                  [
                    verified.connection,
                    { account: verified.account, read: generation },
                  ],
                ]),
              );
            void readHealth().then(
              () => setVerifiedCredentials(new Map()),
              () => setFailure(generation),
            );
          },
        }}
      >
        <button type="button" onClick={() => setShown(!shown)}>
          Toggle source page
        </button>
        {shown && (
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
          />
        )}
      </SourceActivityContext.Provider>
    );
  }
  render(<Fixture />);
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
  expect(readHealth).toHaveBeenCalledOnce();
  await screen.findByText("Signed in as octo");
  await act(async () => {
    rejectCheck(
      new SourceFailure("unauthenticated", "The prior token expired"),
    );
  });
  expect(sourcesClient.signIn).toHaveBeenCalledWith("credential-example", {
    api_key: "synthetic replacing credential",
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByText("Needs sign-in")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Re-enter credentials" }),
  ).toBeNull();
  expect(screen.getByText("Signed in as octo")).toBeTruthy();
  const toggle = screen.getByRole("button", { name: "Toggle source page" });
  fireEvent.click(toggle);
  fireEvent.click(toggle);
  expect(screen.getByText("Signed in as octo")).toBeTruthy();
  expect(screen.queryByText("Needs sign-in")).toBeNull();
  fireEvent.click(
    await screen.findByRole("button", { name: "Retry health check" }),
  );
  await screen.findByText("Needs sign-in");
  expect(readHealth).toHaveBeenCalledTimes(2);
  expect(
    screen.queryByRole("button", { name: "Retry health check" }),
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

test("the section list puts Connections after AI and before Help", async () => {
  vi.mocked(sourcesClient.list).mockResolvedValue([entry]);
  render(<SettingsNav onBack={() => {}} />);
  await screen.findByRole("group", { name: "Connections" });
  const groups = screen
    .getAllByRole("group")
    .map((group) => group.getAttribute("aria-label"));
  expect(groups).toEqual([
    "Preferences",
    "Workspace",
    "AI",
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

test("Sync now reports progress, cancels its run, and shows the next successful sync", async () => {
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
  const sourceCard = (sources: SourceStatus[]) => (
    <SourceActivityContext.Provider
      value={{
        refreshing: false,
        sources,
        entries: null,
        intervalSecs: 300,
        openSettings: () => {},
        refreshAll: async () => {},
      }}
    >
      <SourceCard
        entry={{
          ...entry,
          connector: {
            ...entry.connector,
            provider: "example",
            name: "Example",
          },
          saved: {
            id: "example-2",
            provider: "example",
            config: { repositories: ["o/r"] },
            account: "octo",
            saved_at: "2026-02-01T00:00:00Z",
          },
        }}
      />
    </SourceActivityContext.Provider>
  );
  const view = render(sourceCard([]));
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
  view.rerender(
    sourceCard([
      {
        provider: "example",
        connection_id: "example-2",
        health: "synced",
        last_attempt_at: new Date().toISOString(),
        last_refreshed_at: new Date().toISOString(),
        error: null,
        failing_since: null,
        retry_after: null,
        unavailable_tickets: 0,
        partial_message: null,
      },
    ]),
  );
  expect(sync.getByText(/^Synced/)).toBeTruthy();
  expect(sync.queryByText("Sync canceled")).toBeNull();
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
