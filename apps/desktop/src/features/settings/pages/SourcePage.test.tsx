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
import { SourcePage } from "@/features/settings/pages/SourcePage";
import { SourceActivityContext } from "@/features/tickets/source-activity";
import { sourcesClient, type SourceEntry } from "@/lib/api/sources";
import { githubSource } from "@/test/source-fixtures";

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
  },
}));

const saved = {
  id: "github-2",
  name: "Work",
  provider: "github",
  account: "octo",
  config: { repositories: ["o/r"] },
  saved_at: "2026-01-01T00:00:00Z",
};
const connected: SourceEntry = { ...githubSource, saved };

beforeEach(() => {
  vi.mocked(sourcesClient.checkConnection).mockResolvedValue({
    account: "octo",
  });
  vi.mocked(sourcesClient.configurationSummary).mockResolvedValue([]);
  vi.mocked(sourcesClient.repositoryRoutes).mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function show(
  entry: SourceEntry,
  {
    onBack = vi.fn(),
    onChanged = vi.fn(async () => {}),
    readCatalog = vi.fn(() => 1),
  } = {},
) {
  const page = (current: SourceEntry) => (
    <SourceActivityContext.Provider
      value={{
        refreshing: false,
        sources: [],
        entries: [current],
        readCatalog,
        intervalSecs: null,
        openSettings: () => {},
        refreshAll: async () => {},
      }}
    >
      <SourcePage
        entry={current}
        active
        onBack={onBack}
        onChanged={onChanged}
      />
    </SourceActivityContext.Provider>
  );
  const view = render(page(entry));
  return {
    onBack,
    onChanged,
    readCatalog,
    update: (next: SourceEntry) => view.rerender(page(next)),
  };
}

test("a saved connection renames on its own page without changing its ID", async () => {
  vi.mocked(sourcesClient.rename).mockResolvedValue({
    ...saved,
    name: "Work issues",
  });
  const { readCatalog, update } = show(connected);
  fireEvent.click(await screen.findByRole("button", { name: "Rename Work" }));
  expect(document.activeElement).toBe(
    screen.getByRole("textbox", { name: "Connection name" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Rename Work" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Rename Work" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Connection name" }), {
    target: { value: "Work issues" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));
  expect(
    await screen.findByRole("button", { name: "Rename Work issues" }),
  ).toBeTruthy();
  expect(sourcesClient.rename).toHaveBeenCalledWith("github-2", "Work issues");
  expect(readCatalog).toHaveBeenCalledOnce();
  // The confirmed catalog takes over from the name just saved.
  update({ ...connected, saved: { ...saved, name: "Renamed elsewhere" } });
  expect(
    screen.getByRole("button", { name: "Rename Renamed elsewhere" }),
  ).toBeTruthy();
});

test("removing a connection asks first, then returns to the table", async () => {
  vi.mocked(sourcesClient.remove).mockResolvedValue(undefined);
  const { onBack, onChanged } = show(connected);
  const remove = await screen.findByRole("button", { name: "Remove Work" });
  fireEvent.click(remove);
  const dialog = screen.getByRole("dialog", { name: "Remove Work?" });
  expect(
    within(dialog).getByText(/last synced content, local work/),
  ).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(sourcesClient.remove).not.toHaveBeenCalled();
  expect(onBack).not.toHaveBeenCalled();

  fireEvent.click(remove);
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "Remove Work?" })).getByRole(
      "button",
      { name: "Remove connection" },
    ),
  );
  await waitFor(() => expect(onBack).toHaveBeenCalledOnce());
  expect(sourcesClient.remove).toHaveBeenCalledExactlyOnceWith("github-2");
  expect(onChanged).toHaveBeenCalledOnce();
});

test("a failed removal stays on the page and says so", async () => {
  vi.mocked(sourcesClient.remove).mockRejectedValue(new Error("disk full"));
  const { onBack } = show(connected);
  fireEvent.click(await screen.findByRole("button", { name: "Remove Work" }));
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Remove connection",
    }),
  );
  await within(screen.getByRole("dialog")).findByRole("alert");
  expect(onBack).not.toHaveBeenCalled();
});

test("a source that is not connected yet has nothing to rename or remove", async () => {
  show({ ...githubSource, next_id: "github" });
  await screen.findByRole("heading", { level: 1, name: "GitHub" });
  expect(screen.queryByRole("button", { name: /^Rename/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
});

test("an unavailable source's page says what happened and still renames and removes", async () => {
  vi.mocked(sourcesClient.remove).mockResolvedValue(undefined);
  const unavailable: SourceEntry = {
    connector: {
      ...githubSource.connector,
      name: "Fixture Tracker",
      provider: "tracker",
    },
    saved: {
      ...saved,
      id: "tracker",
      name: "Archived tracker",
      provider: "tracker",
    },
    unavailable: true,
  };
  const { onBack } = show(unavailable);
  expect(
    await screen.findByText(
      /program for this source is missing or has changed/,
    ),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Rename Archived tracker" }),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Remove Archived tracker" }),
  );
  await act(async () => {
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Remove connection",
      }),
    );
  });
  await waitFor(() => expect(onBack).toHaveBeenCalled());
  expect(sourcesClient.remove).toHaveBeenCalledWith("tracker");
});
