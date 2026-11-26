// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SourcePage } from "@/features/settings/pages/SourcePage";
import { SourcesPage } from "@/features/settings/pages/SourcesPage";
import { SourceActivityContext } from "@/features/tickets/source-activity";
import {
  SourceFailure,
  sourcesClient,
  type ExtensionConsent,
  type SourceEntry,
} from "@/lib/api/sources";
import { workspaceClient } from "@/lib/api/workspace";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
Element.prototype.scrollIntoView ??= () => {};
vi.mock("@/lib/api/sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/sources")>()),
  sourcesClient: {
    list: vi.fn(),
    checkConnection: vi.fn(),
    configurationSummary: vi.fn(),
    repositoryRoutes: vi.fn(),
    options: vi.fn(),
    preview: vi.fn(),
    save: vi.fn(),
    add: vi.fn(),
    signIn: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
    refresh: vi.fn(),
    cancelRefresh: vi.fn(),
    prepareExtension: vi.fn(),
    addExtension: vi.fn(),
    cancelExtension: vi.fn(),
    removeExtension: vi.fn(),
  },
}));

const extension = {
  id: "jira",
  version: "0.3.1",
  path: "/registry/.source-package-jira.1/package",
  development: false,
  hosts: ["sam-team.atlassian.net", "api.atlassian.com"],
  command: "node dist/index.js",
  origin: "/Users/sam/Downloads/ticketd-jira",
  stopped: false,
  bundled: false,
};
const consent: ExtensionConsent = {
  token: "token-1",
  extension,
  executable: "/usr/local/bin/node",
  args: ["dist/index.js"],
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
      hosts: ["sam-team.atlassian.net"],
      target: {
        field: "projects",
        label: "Project",
        example: "WEB",
        choose: "Choose a project",
        add: "Add a project",
      },
    },
  },
  saved: null,
  next_id: "jira",
  extension,
};
const stopped: SourceEntry = {
  ...jira,
  unavailable: true,
  extension: { ...extension, stopped: true },
};

function failure(code: string, message: string) {
  return new SourceFailure(code as never, message);
}

beforeEach(() => {
  vi.spyOn(workspaceClient, "chooseFolder").mockResolvedValue(
    "/Users/sam/Downloads/ticketd-jira",
  );
  vi.mocked(sourcesClient.cancelExtension).mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function context(
  entries: SourceEntry[],
  readCatalog: () => number = vi.fn(() => 1),
) {
  return {
    refreshing: false,
    sources: [],
    entries,
    readCatalog,
    intervalSecs: null,
    openSettings: () => {},
    refreshAll: async () => {},
  };
}

function showTable(entries: SourceEntry[] = []) {
  const onOpen = vi.fn();
  const readCatalog = vi.fn(() => 1);
  render(
    <SourceActivityContext.Provider value={context(entries, readCatalog)}>
      <SourcesPage onOpen={onOpen} />
    </SourceActivityContext.Provider>,
  );
  return { onOpen, readCatalog };
}

async function pickFolder() {
  fireEvent.click(screen.getByRole("button", { name: "Add a custom source" }));
}

test("the add row names what a custom source is and picks a folder with the system dialog", async () => {
  vi.mocked(sourcesClient.prepareExtension).mockResolvedValue(consent);
  showTable();
  expect(
    screen.getByText(
      "A program built on ticketd’s ticket source contract, by you or someone else.",
    ),
  ).toBeTruthy();
  await pickFolder();
  await screen.findByRole("dialog");
  expect(workspaceClient.chooseFolder).toHaveBeenCalledOnce();
  expect(sourcesClient.prepareExtension).toHaveBeenCalledWith(
    "/Users/sam/Downloads/ticketd-jira",
  );
});

test("the consent says what it costs first, then the facts, and adds nothing until approved", async () => {
  vi.mocked(sourcesClient.prepareExtension).mockResolvedValue(consent);
  showTable();
  await pickFolder();
  const dialog = await screen.findByRole("dialog", {
    name: "Add Jira as a ticket source?",
  });
  const text = dialog.textContent ?? "";
  const consequence = text.indexOf(
    "It runs on this computer as you, with access to your files and the network.",
  );
  expect(consequence).toBeGreaterThan(-1);
  const facts = within(dialog)
    .getAllByRole("term")
    .map((term) => term.textContent);
  expect(facts).toEqual(["Source", "Runs", "Connects to", "From"]);
  expect(text.indexOf("Source")).toBeGreaterThan(consequence);
  expect(within(dialog).getByText("jira 0.3.1")).toBeTruthy();
  expect(within(dialog).getByText("node dist/index.js")).toBeTruthy();
  expect(
    within(dialog).getByText("sam-team.atlassian.net, api.atlassian.com"),
  ).toBeTruthy();
  expect(within(dialog).getByText("~/Downloads/ticketd-jira")).toBeTruthy();
  expect(within(dialog).getByText("Add only programs you trust.")).toBeTruthy();
  expect(sourcesClient.addExtension).not.toHaveBeenCalled();

  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(sourcesClient.cancelExtension).toHaveBeenCalledWith("token-1");
  expect(sourcesClient.addExtension).not.toHaveBeenCalled();
});

test("adding approves exactly what was shown, then opens the new source's page", async () => {
  vi.mocked(sourcesClient.prepareExtension).mockResolvedValue(consent);
  vi.mocked(sourcesClient.addExtension).mockResolvedValue(extension);
  const { onOpen, readCatalog } = showTable([jira]);
  await pickFolder();
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: "Add source",
    }),
  );
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith("jira"));
  expect(sourcesClient.addExtension).toHaveBeenCalledWith("token-1");
  expect(readCatalog).toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("a failed add keeps the dialog open and says so", async () => {
  vi.mocked(sourcesClient.prepareExtension).mockResolvedValue(consent);
  vi.mocked(sourcesClient.addExtension).mockRejectedValue(
    failure("protocol", "the extension did not answer its handshake"),
  );
  const { onOpen } = showTable();
  await pickFolder();
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Add source" }));
  await within(screen.getByRole("dialog")).findByRole("alert");
  expect(onOpen).not.toHaveBeenCalled();
});

test.each([
  ["no_manifest", "This folder has no ticketd-source.json"],
  ["needs_newer_ticketd", "It needs a newer ticketd"],
  ["not_a_folder", "This isn't a folder"],
  [
    "invalid_manifest",
    "ticketd-source.json can't be used: the manifest needs a version",
  ],
])("a folder that can't be added (%s) says why and never opens the dialog", async (code, message) => {
  vi.mocked(sourcesClient.prepareExtension).mockRejectedValue(
    failure(code, message),
  );
  showTable();
  await pickFolder();
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toBe(message);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(sourcesClient.addExtension).not.toHaveBeenCalled();
});

test("closing the folder chooser changes nothing", async () => {
  vi.mocked(workspaceClient.chooseFolder).mockResolvedValue(null);
  showTable();
  await pickFolder();
  await waitFor(() => expect(workspaceClient.chooseFolder).toHaveBeenCalled());
  expect(sourcesClient.prepareExtension).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});

function showSource(entry: SourceEntry) {
  const onBack = vi.fn();
  const onChanged = vi.fn(async () => {});
  const onOpen = vi.fn();
  const readCatalog = vi.fn(() => 1);
  render(
    <SourceActivityContext.Provider value={context([entry], readCatalog)}>
      <SourcePage
        entry={entry}
        active
        onBack={onBack}
        onChanged={onChanged}
        onOpen={onOpen}
      />
    </SourceActivityContext.Provider>,
  );
  return { onBack, onChanged, onOpen, readCatalog };
}

test("an added source opens as Custom, not connected yet, with its program", async () => {
  showSource(jira);
  expect(screen.getByRole("heading", { level: 1, name: "Jira" })).toBeTruthy();
  expect(screen.getByText("Custom")).toBeTruthy();
  expect(
    screen.getByText("Your Jira issues arrive as tickets. Edit them in Jira."),
  ).toBeTruthy();
  expect(screen.getByText("Not connected yet")).toBeTruthy();
  expect(
    screen.getByText(
      "Sign in with an API token, then choose the projects that come in.",
    ),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Add a connection" })).toBeTruthy();
  const program = screen.getByRole("heading", { level: 2, name: "Program" })
    .closest("section")!;
  expect(
    within(program)
      .getAllByRole("term")
      .map((term) => term.textContent),
  ).toEqual(["Source", "Runs", "Connects to", "Added from"]);
  expect(within(program).getByText("jira 0.3.1")).toBeTruthy();
  expect(
    within(program).getByText(
      "ticketd stops it if its files change, until you add it again.",
    ),
  ).toBeTruthy();
  expect(within(program).queryByText("Add again…")).toBeNull();
  expect(
    within(program).getByRole("button", { name: "Remove source…" }),
  ).toBeTruthy();
});

test("Add a connection opens the program's own form, and a saved connection opens its page", async () => {
  vi.mocked(sourcesClient.configurationSummary).mockResolvedValue([]);
  const { onChanged, onOpen } = showSource(jira);
  fireEvent.click(screen.getByRole("button", { name: "Add a connection" }));
  expect(
    await screen.findByRole("heading", { name: "Add Jira connection" }),
  ).toBeTruthy();
  expect(screen.getByLabelText("Connection name")).toBeTruthy();
  expect(onChanged).not.toHaveBeenCalled();
  expect(onOpen).not.toHaveBeenCalled();
});

test("a source whose files changed shows it stopped and adds again with the consent", async () => {
  vi.mocked(sourcesClient.prepareExtension).mockResolvedValue({
    ...consent,
    token: "token-2",
  });
  vi.mocked(sourcesClient.addExtension).mockResolvedValue(extension);
  const { readCatalog } = showSource(stopped);
  expect(
    screen.getByText(
      "Its files changed, so ticketd stopped it. It stays stopped until you add it again.",
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Add again…" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Add Jira as a ticket source?",
  });
  expect(sourcesClient.addExtension).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Add source" }));
  await waitFor(() =>
    expect(sourcesClient.addExtension).toHaveBeenCalledWith("token-2"),
  );
  expect(readCatalog).toHaveBeenCalled();
});

test("adding again refuses the folder of another source", async () => {
  vi.mocked(sourcesClient.prepareExtension).mockResolvedValue({
    ...consent,
    extension: { ...extension, id: "linear-ish" },
  });
  showSource(stopped);
  fireEvent.click(screen.getByRole("button", { name: "Add again…" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("linear-ish, not jira");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(sourcesClient.cancelExtension).toHaveBeenCalledWith("token-1");
});

test("removing a source asks first and returns to the table", async () => {
  vi.mocked(sourcesClient.removeExtension).mockResolvedValue(undefined);
  const { onBack, onChanged } = showSource(jira);
  fireEvent.click(screen.getByRole("button", { name: "Remove source…" }));
  const dialog = screen.getByRole("dialog", { name: "Remove Jira?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(sourcesClient.removeExtension).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Remove source…" }));
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Remove source",
    }),
  );
  await waitFor(() => expect(onBack).toHaveBeenCalled());
  expect(sourcesClient.removeExtension).toHaveBeenCalledWith("jira");
  expect(onChanged).toHaveBeenCalled();
});
