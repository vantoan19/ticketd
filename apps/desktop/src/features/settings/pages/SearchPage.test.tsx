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
import {
  SEARCH_INPUT_ID,
  type SettingsPageId,
} from "@/features/settings/settings-sections";
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

/** The page as the app mounts it: the query is typed in the nav's field, so the test brings one. */
function Harness({
  openSetting,
  query = "",
  fieldKey = "one",
}: {
  openSetting: (page: SettingsPageId, title: string) => void;
  query?: string;
  /** A new key replaces the field with a new element, as a narrow window moves it into the sheet. */
  fieldKey?: string;
}) {
  return (
    <SettingsStateContext.Provider
      value={{
        query,
        setQuery: () => {},
        openPage: () => {},
        openSetting,
        needsSetup: {},
        refreshIndicators: () => {},
      }}
    >
      <input
        key={fieldKey}
        id={SEARCH_INPUT_ID}
        type="search"
        aria-label="Search settings"
      />
      <SearchPage />
    </SettingsStateContext.Provider>
  );
}

const field = () => screen.getByRole("searchbox", { name: "Search settings" });
const results = () => screen.getAllByRole("link");
const titles = () =>
  results().map(
    (link) => link.querySelector(".settings-list-row-title")?.textContent,
  );
const selected = () =>
  results().filter((link) => link.getAttribute("aria-current") === "true");

test("an empty query asks for a word and lists nothing", () => {
  render(<Harness openSetting={() => {}} />);
  expect(screen.getByRole("status").textContent).toBe(
    "Type to search every setting by name, description or related word.",
  );
  expect(screen.queryByRole("link")).toBeNull();
  // The one field is in the nav; the page has none of its own.
  expect(screen.getAllByRole("searchbox")).toHaveLength(1);
});

test("results are one flat list under a count, with the page of each as Group › Page", () => {
  render(<Harness openSetting={() => {}} query="report" />);
  expect(screen.getByRole("heading", { level: 2 }).textContent).toMatch(
    /^\d+ settings match “report”$/,
  );
  expect(screen.getByText("Enter opens the first one.")).toBeTruthy();
  const star = results().find((link) =>
    link.textContent?.includes("Report an issue"),
  );
  expect(
    star?.querySelector(".settings-list-row-description")?.textContent,
  ).toBe("Help › About");
  // The page's icon, then the name, the page and a chevron.
  expect(star?.querySelectorAll("svg")).toHaveLength(2);
  // No box per page, and no description of the setting.
  expect(screen.queryAllByRole("region")).toHaveLength(1);
});

test("one match reads in the singular", () => {
  render(<Harness openSetting={() => {}} query="onboarding" />);
  expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
    "1 setting matches “onboarding”",
  );
});

test("the page's own title ranks first: files and attachments list the Files page before rows that mention it", () => {
  for (const query of ["files", "attachments"]) {
    const { unmount } = render(
      <Harness openSetting={() => {}} query={query} />,
    );
    const where = results().map(
      (link) =>
        link.querySelector(".settings-list-row-description")?.textContent,
    );
    expect(where[0], query).toBe("Workspace › Files");
    const lastFiles = where.lastIndexOf("Workspace › Files");
    expect(where.slice(0, lastFiles + 1), query).toEqual(
      Array(lastFiles + 1).fill("Workspace › Files"),
    );
    unmount();
  }
});

test("the first result is selected, and the match is marked in its title", () => {
  render(<Harness openSetting={() => {}} query="theme" />);
  expect(selected()).toEqual([results()[0]]);
  expect(results()[0]?.querySelector("mark")?.textContent).toBe("Theme");
});

test("Enter in the field opens the first result", () => {
  const openSetting = vi.fn();
  render(<Harness openSetting={openSetting} query="theme" />);
  fireEvent.keyDown(field(), { key: "Enter" });
  expect(openSetting).toHaveBeenCalledTimes(1);
  expect(openSetting).toHaveBeenCalledWith("appearance", "Theme");
});

test("the arrows move the selection and stop at both ends; Enter opens the selected result", () => {
  const openSetting = vi.fn();
  render(<Harness openSetting={openSetting} query="backup" />);
  const count = results().length;
  expect(count).toBeGreaterThan(2);
  fireEvent.keyDown(field(), { key: "ArrowUp" });
  expect(selected()).toEqual([results()[0]]);
  fireEvent.keyDown(field(), { key: "ArrowDown" });
  fireEvent.keyDown(field(), { key: "ArrowDown" });
  expect(selected()).toEqual([results()[2]]);
  expect(field().getAttribute("aria-activedescendant")).toBe(results()[2]?.id);
  fireEvent.keyDown(field(), { key: "Enter" });
  expect(openSetting).toHaveBeenCalledWith(
    "backups-export",
    titles()[2] as string,
  );
  for (let press = 0; press < count; press += 1)
    fireEvent.keyDown(field(), { key: "ArrowDown" });
  expect(selected()).toEqual([results()[count - 1]]);
  fireEvent.keyDown(field(), { key: "ArrowUp" });
  expect(selected()).toEqual([results()[count - 2]]);
});

test("a new query selects the first result again", () => {
  const { rerender } = render(
    <Harness openSetting={() => {}} query="backup" />,
  );
  fireEvent.keyDown(field(), { key: "ArrowDown" });
  expect(selected()).toEqual([results()[1]]);
  rerender(<Harness openSetting={() => {}} query="backups" />);
  expect(selected()).toEqual([results()[0]]);
});

test("while the page fades out after the field is cleared, the last results stay", () => {
  const { rerender } = render(
    <Harness openSetting={() => {}} query="backup" />,
  );
  const before = titles();
  rerender(<Harness openSetting={() => {}} query="" />);
  expect(titles()).toEqual(before);
  expect(
    screen.queryByText(
      "Type to search every setting by name, description or related word.",
    ),
  ).toBeNull();
});

test("choosing a result opens its page and names the setting to show", () => {
  const openSetting = vi.fn();
  render(<Harness openSetting={openSetting} query="backup" />);
  fireEvent.click(screen.getByRole("link", { name: /Restore points/ }));
  expect(openSetting).toHaveBeenCalledWith("backups-export", "Restore points");
});

test("a query with no match says so, offers other words and no shortcuts", () => {
  sourceList = [githubSource];
  const openSetting = vi.fn();
  render(<Harness openSetting={openSetting} query="proxy" />);
  expect(screen.getByText("No settings match “proxy”")).toBeTruthy();
  expect(
    screen.getByText("Try another word, such as theme, sync or backup."),
  ).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  // Enter has nothing to open.
  fireEvent.keyDown(field(), { key: "Enter" });
  expect(openSetting).not.toHaveBeenCalled();
});

test("a connection is a result on Ticket sources, and its own rows open its page", () => {
  sourceList = [githubSource];
  const openSetting = vi.fn();
  render(<Harness openSetting={openSetting} query="github" />);
  const first = results()[0] as HTMLElement;
  expect(within(first).getByText("GitHub", { selector: "mark" })).toBeTruthy();
  expect(first.textContent).toContain("Connections › Ticket sources");
  fireEvent.click(first);
  expect(openSetting).toHaveBeenLastCalledWith("ticket-sources", "GitHub");
  fireEvent.click(screen.getByRole("link", { name: /^Discovery/ }));
  expect(openSetting).toHaveBeenLastCalledWith("source-github", "Discovery");
});

test("arrows and Enter still drive the results after the nav replaces the search field", () => {
  const openSetting = vi.fn();
  const { rerender } = render(
    <Harness openSetting={openSetting} query="report" />,
  );
  rerender(
    <Harness openSetting={openSetting} query="report" fieldKey="sheet" />,
  );
  fireEvent.keyDown(field(), { key: "ArrowDown" });
  expect(selected()).toEqual([results()[1]]);
  fireEvent.keyDown(field(), { key: "Enter" });
  expect(openSetting).toHaveBeenCalledTimes(1);
  expect(openSetting.mock.calls[0]?.[1]).toBe(titles()[1]);
  // The new field names the selected result for screen readers.
  expect(field().getAttribute("aria-activedescendant")).toBe(results()[1]?.id);
});

test("a selection past the end of a shortened result list falls back to the last result", () => {
  const second: SourceEntry = {
    ...githubSource,
    saved: {
      id: "github-work",
      name: "GitHub work",
      provider: "github",
      config: {},
      account: "octo",
      saved_at: "2026-01-01T00:00:00Z",
    },
  };
  sourceList = [githubSource, second];
  const openSetting = vi.fn();
  const { rerender } = render(
    <Harness openSetting={openSetting} query="github" />,
  );
  const many = results().length;
  for (let step = 0; step < many; step += 1)
    fireEvent.keyDown(field(), { key: "ArrowDown" });
  expect(selected()).toEqual([results()[many - 1]]);
  // A connection goes away while the same words are typed.
  sourceList = [githubSource];
  rerender(<Harness openSetting={openSetting} query="github" />);
  expect(results().length).toBeLessThan(many);
  expect(selected()).toEqual([results()[results().length - 1]]);
  fireEvent.keyDown(field(), { key: "Enter" });
  expect(openSetting).toHaveBeenCalledTimes(1);
  expect(field().getAttribute("aria-activedescendant")).toBe(
    results()[results().length - 1]?.id,
  );
});
