// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SearchPage } from "@/features/settings/pages/SearchPage";
import { SettingsStateContext } from "@/features/settings/use-settings-state";
import type { SettingsPageId } from "@/features/settings/settings-sections";
import type { SourceEntry } from "@/lib/api/sources";
import { githubSource } from "@/test/source-fixtures";

vi.mock("@/features/settings/sources/use-sources", () => ({
  useSources: () => ({ entries: sourceList, loading: false }),
}));

let sourceList: SourceEntry[] = [];

afterEach(() => {
  cleanup();
  sourceList = [];
});

/** The page as the app mounts it: the query is typed in the nav's field, so the test sets it. */
function Harness({
  openPage,
  query: initial = "",
}: {
  openPage: (page: SettingsPageId) => void;
  query?: string;
}) {
  return (
    <SettingsStateContext.Provider
      value={{
        query: initial,
        setQuery: () => {},
        openPage,
        needsSetup: {},
        refreshIndicators: () => {},
      }}
    >
      <SearchPage />
    </SettingsStateContext.Provider>
  );
}

test("an empty query asks for a word and lists nothing", () => {
  render(<Harness openPage={() => {}} />);
  expect(screen.getByRole("status").textContent).toBe(
    "Type to search every setting by name, description or related word.",
  );
  expect(screen.queryByRole("link")).toBeNull();
  // The one field is in the nav; the page has none of its own.
  expect(screen.queryByRole("searchbox")).toBeNull();
});

test("results are grouped by page with a count and open the page on choosing", () => {
  const openPage = vi.fn();
  render(<Harness openPage={openPage} query="backup" />);
  const status = screen.getByRole("status").textContent ?? "";
  expect(status).toMatch(
    /^\d+ settings? in \d+ sections?\. Choose one to open its page\.$/,
  );
  const group = screen.getByRole("region", { name: "Backups & export" });
  expect(group.textContent).toMatch(/Workspace · \d+ settings?/);
  fireEvent.click(within(group).getByRole("link", { name: /Restore points/ }));
  expect(openPage).toHaveBeenCalledWith("backups-export");
});

test("the match is highlighted in the title", () => {
  render(<Harness openPage={() => {}} query="theme" />);
  const marks = Array.from(document.querySelectorAll("mark"));
  expect(marks.length).toBeGreaterThan(0);
  expect(marks[0]?.textContent).toBe("Theme");
});

test("a query with no match says so and offers shortcuts to Appearance, Backups & export and the first source", () => {
  sourceList = [githubSource];
  const openPage = vi.fn();
  render(<Harness openPage={openPage} query="zzzzqqq" />);
  expect(screen.getByRole("status").textContent).toBe("No matches.");
  expect(screen.getByText("No settings match “zzzzqqq”")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Backups & export" }));
  expect(openPage).toHaveBeenLastCalledWith("backups-export");
  fireEvent.click(screen.getByRole("button", { name: "GitHub" }));
  expect(openPage).toHaveBeenLastCalledWith("source-github");
  fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
  expect(openPage).toHaveBeenLastCalledWith("appearance");
});

test("an available source's settings are searchable and land on its page", () => {
  sourceList = [githubSource];
  const openPage = vi.fn();
  render(<Harness openPage={openPage} query="discovery" />);
  const group = screen.getByRole("region", { name: "GitHub" });
  fireEvent.click(within(group).getByRole("link", { name: /^Discovery/ }));
  expect(openPage).toHaveBeenCalledWith("source-github");
});

test("with no source the empty state has only the two shortcuts", () => {
  render(<Harness openPage={() => {}} query="zzzzqqq" />);
  expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
    "Appearance",
    "Backups & export",
  ]);
});
