import { expect, test } from "vitest";
import { SETTINGS_SECTIONS, sourceSection } from "./settings-sections";
import {
  SETTINGS_ENTRIES,
  searchSettings,
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
    "GitHub connection",
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
  expect(first("Largest file")?.section).toBe("attachments");
  expect(first("upload limit")?.section).toBe("attachments");
  expect(first("Check for changes every")?.section).toBe("google-drive");
  expect(first("Third-party notices")?.section).toBe("about");
  expect(first("Dialogs and menus")?.section).toBe("keyboard-shortcuts");
});

test("no two rows on one page share a title", () => {
  const seen = new Set<string>();
  for (const { section, title } of SETTINGS_ENTRIES) {
    const key = `${section}:${title}`;
    expect(seen.has(key), key).toBe(false);
    seen.add(key);
  }
});
