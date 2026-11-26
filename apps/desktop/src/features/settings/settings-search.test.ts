import { expect, test } from "vitest";
import { SETTINGS_SECTIONS, sourceSection } from "./settings-sections";
import {
  SETTINGS_ENTRIES,
  searchSettings,
  searchSettingsFor,
  sourceEntries,
  splitMatch,
} from "./settings-search";

const sectionIds = new Set<string>(SETTINGS_SECTIONS.map(({ id }) => id));

test("every registry entry names a real section", () => {
  for (const entry of SETTINGS_ENTRIES)
    expect(sectionIds.has(entry.section), entry.title).toBe(true);
});

test("every section has at least one entry and entries are complete", () => {
  for (const id of sectionIds)
    expect(
      SETTINGS_ENTRIES.some((entry) => entry.section === id),
      id,
    ).toBe(true);
  for (const entry of SETTINGS_ENTRIES) {
    expect(entry.title.trim(), entry.title).not.toBe("");
    expect(entry.description.trim(), entry.title).not.toBe("");
  }
});

test("an available source adds Connection, Discovery and Sync entries in its own section", () => {
  const entries = sourceEntries("github", "GitHub");
  expect(entries.map((entry) => entry.title)).toEqual([
    "Connection",
    "Discovery",
    "Sync",
  ]);
  const { id } = sourceSection("github", "GitHub");
  expect(entries.every((entry) => entry.section === id)).toBe(true);
});

test("results rank title matches, then description, then keywords", () => {
  const entries = [
    { title: "Alpha", description: "x", keywords: "folder", section: "about" },
    { title: "B", description: "a folder here", section: "about" },
    { title: "Folder", description: "y", section: "about" },
  ] as const;
  const hits = searchSettings("folder", entries);
  expect(hits.map((hit) => hit.title)).toEqual(["Folder", "B", "Alpha"]);
});

test("matching ignores case and surrounding space, and an empty query matches nothing", () => {
  expect(searchSettings("  THEME ", SETTINGS_ENTRIES).length).toBeGreaterThan(
    0,
  );
  expect(searchSettings("   ", SETTINGS_ENTRIES)).toEqual([]);
  expect(searchSettings("zzzzqqq", SETTINGS_ENTRIES)).toEqual([]);
});

test("related words find a setting by what it does", () => {
  const titles = searchSettings("dark mode", SETTINGS_ENTRIES).map(
    (hit) => hit.title,
  );
  expect(titles).toContain("Theme");
});

test("splitMatch cuts text around the first match, keeping its original case", () => {
  expect(splitMatch("Back up now", "up")).toEqual(["Back ", "up", " now"]);
  expect(splitMatch("Theme", "UP")).toEqual(["Theme", "", ""]);
  expect(splitMatch("Theme", "")).toEqual(["Theme", "", ""]);
});

test("search finds a row by the title its page shows", () => {
  const first = (query: string) => searchSettings(query, SETTINGS_ENTRIES)[0];
  expect(first("Largest file")?.section).toBe("files");
  expect(first("upload limit")?.section).toBe("files");
  expect(first("Check for changes every")?.section).toBe("workspace-sync");
  expect(first("Third-party notices")?.section).toBe("about");
  expect(first("Dialogs and menus")?.section).toBe("keyboard-shortcuts");
});

test("sync is found on Workspace sync by either storage, and Drive uploads on Files", () => {
  const sections = (query: string) =>
    searchSettings(query, SETTINGS_ENTRIES).map((hit) => hit.section);
  for (const query of ["sync", "s3 bucket", "aws profile", "sso"])
    expect(sections(query)[0], query).toBe("workspace-sync");
  expect(sections("google drive account")[0]).toBe("files");
});

test("no two rows on one page share a title", () => {
  const seen = new Set<string>();
  for (const { section, title } of SETTINGS_ENTRIES) {
    const key = `${section}:${title}`;
    expect(seen.has(key), key).toBe(false);
    seen.add(key);
  }
});

test("a query matches the beginnings of words, never the middle of one", () => {
  const titles = (query: string) =>
    searchSettings(query, SETTINGS_ENTRIES).map((hit) => hit.title);
  // "rows" sits inside "browser" and "board" inside "keyboard".
  expect(titles("rows")).not.toContain("Report an issue");
  expect(titles("board")).toEqual(["Lists"]);
  expect(titles("key")).toContain("Everywhere");
  expect(titles("back")).toContain("Back up now");
});

test("every word of a query must match", () => {
  const titles = (query: string) =>
    searchSettings(query, SETTINGS_ENTRIES).map((hit) => hit.title);
  expect(titles("restore backup")).toContain("Restore from a backup");
  expect(titles("restore zzzz")).toEqual([]);
});

test("harness finds the Harnesses section of the Agents page", () => {
  const [first] = searchSettings("harness", SETTINGS_ENTRIES);
  expect(first).toMatchObject({ title: "Harnesses", section: "agents" });
});

test("experimental finds the Agents and Automations pages as well as Show Chat", () => {
  const sections = searchSettings("experimental", SETTINGS_ENTRIES).map(
    (hit) => hit.section,
  );
  expect(sections).toEqual(expect.arrayContaining(["agents", "automations"]));
});

test("a description from the page finds its row", () => {
  const [first] = searchSettings("all file types", SETTINGS_ENTRIES);
  expect(first).toMatchObject({ title: "Upload limit" });
});

test("splitMatch marks a word start, not the middle of a word", () => {
  expect(splitMatch("Report an issue in your browser", "rows")).toEqual([
    "Report an issue in your browser",
    "",
    "",
  ]);
  expect(splitMatch("Back up now", "back up")).toEqual(["", "Back up", " now"]);
  expect(splitMatch("Keyboard shortcuts", "short")).toEqual([
    "Keyboard ",
    "short",
    "cuts",
  ]);
});

test("while Chat is off, a Chat-only word finds the Agents page, not the hidden rows", () => {
  const off = searchSettingsFor("harness", SETTINGS_ENTRIES, false);
  expect(off).toHaveLength(1);
  expect(off[0]).toMatchObject({ title: "Agents", section: "agents" });
  expect(off[0]?.description).toMatch(/turn on chat.*harnesses/i);
  const on = searchSettingsFor("harness", SETTINGS_ENTRIES, true);
  expect(on.map((hit) => hit.title)).toEqual(["Harnesses"]);
  // Words that already find a visible Chat row need no stand-in.
  expect(
    searchSettingsFor("chat", SETTINGS_ENTRIES, false).filter(
      (hit) => hit.title === "Agents" && hit.section === "agents",
    ),
  ).toEqual([]);
});
