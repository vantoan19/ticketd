import { expect, test } from "vitest";
import { SETTINGS_SECTIONS, sourceSection } from "./settings-sections";
import {
  SETTINGS_ENTRIES,
  searchSettings,
  searchSettingsFor,
  sourceEntries,
  splitMatch,
  supportEntries,
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

test("an available source adds its row in Ticket sources, then Connection, Discovery and Sync in its own section", () => {
  const entries = sourceEntries("github", "GitHub");
  expect(entries.map((entry) => entry.title)).toEqual([
    "GitHub",
    "Connection",
    "Discovery",
    "Sync",
  ]);
  expect(entries[0]?.section).toBe("ticket-sources");
  const { id } = sourceSection("github", "GitHub");
  expect(entries.slice(1).every((entry) => entry.section === id)).toBe(true);
});

test("a renamed connection is found by the name its table row shows", () => {
  const entries = sourceEntries("work", "GitHub", [], "Work GitHub");
  expect(searchSettings("work", entries)[0]).toMatchObject({
    title: "Work GitHub",
    section: "ticket-sources",
  });
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

test("a page's title outranks a row's title, a description and keywords", () => {
  const entries = [
    { title: "Y", description: "d", keywords: "files", section: "about" },
    { title: "X", description: "your files", section: "about" },
    { title: "Files here", description: "d", section: "about" },
    { title: "Other", description: "d", section: "files" },
  ] as const;
  expect(searchSettings("files", entries).map((hit) => hit.title)).toEqual([
    "Other",
    "Files here",
    "X",
    "Y",
  ]);
});

test("#520: files and attachments find the Files page before a row that only mentions them", () => {
  for (const query of ["files", "attachments"]) {
    const hits = searchSettings(query, SETTINGS_ENTRIES);
    expect(hits[0]?.section, query).toBe("files");
    const firstElsewhere = hits.findIndex((hit) => hit.section !== "files");
    expect(firstElsewhere, query).toBeGreaterThan(0);
    // Every row of the page comes before the first row of another page.
    expect(
      hits.slice(firstElsewhere).some((hit) => hit.section === "files"),
      query,
    ).toBe(false);
  }
});

test("equal ranks keep the sidebar's order of pages, then the registry's order of rows", () => {
  const entries = [
    { title: "Zebra about", description: "d", section: "about" },
    { title: "Zebra sources", description: "d", section: "source-github" },
    { title: "Zebra theme", description: "d", section: "appearance" },
    { title: "Zebra sync", description: "d", section: "workspace-sync" },
    { title: "Zebra again", description: "d", section: "appearance" },
  ] as const;
  expect(searchSettings("zebra", entries).map((hit) => hit.title)).toEqual([
    "Zebra theme",
    "Zebra again",
    "Zebra sync",
    "Zebra sources",
    "Zebra about",
  ]);
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
  expect(first("New files")?.section).toBe("files");
  expect(first("Google account")?.section).toBe("files");
  expect(first("Check for changes every")?.section).toBe("workspace-sync");
  expect(first("Third-party notices")?.section).toBe("about");
  expect(first("Dialogs and menus")?.section).toBe("keyboard-shortcuts");
});

test("sync is found on Workspace sync by either storage, and Drive uploads on Files", () => {
  const sections = (query: string) =>
    searchSettings(query, SETTINGS_ENTRIES).map((hit) => hit.section);
  for (const query of ["sync", "s3 bucket", "aws profile", "sso"])
    expect(sections(query)[0], query).toBe("workspace-sync");
  expect(sections("google account")[0]).toBe("files");
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
  expect(titles("board")).toEqual(["Lists", "Ticket"]);
  expect(titles("key")).toContain("Everywhere");
  expect(titles("back")).toContain("Restore points");
});

test("every word of a query must match", () => {
  const titles = (query: string) =>
    searchSettings(query, SETTINGS_ENTRIES).map((hit) => hit.title);
  expect(titles("restore backup")).toContain("Restore points");
  expect(titles("restore zzzz")).toEqual([]);
});

test("harness finds the agents on this computer", () => {
  const [first] = searchSettings("harness", SETTINGS_ENTRIES);
  expect(first).toMatchObject({ title: "On this computer", section: "agents" });
});

test("experimental finds the Agents and Automations pages", () => {
  const sections = searchSettings("experimental", SETTINGS_ENTRIES).map(
    (hit) => hit.section,
  );
  expect(sections).toEqual(expect.arrayContaining(["agents", "automations"]));
});

test("a description from the page finds its row", () => {
  const [first] = searchSettings("already attached", SETTINGS_ENTRIES);
  expect(first).toMatchObject({ title: "New files" });
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

test("while Chat is off, an Automations word finds the Agents page, not the hidden rows", () => {
  const off = searchSettingsFor("tray", SETTINGS_ENTRIES, false);
  expect(off).toHaveLength(1);
  expect(off[0]).toMatchObject({ title: "Agents", section: "agents" });
  expect(off[0]?.description).toMatch(/turn on chats.*automations/i);
  const on = searchSettingsFor("tray", SETTINGS_ENTRIES, true);
  expect(on.map((hit) => hit.title)).toEqual([
    "Start ticketd when you sign in",
  ]);
  // Words that already find a visible Chat row need no stand-in.
  expect(
    searchSettingsFor("chat", SETTINGS_ENTRIES, false).filter(
      (hit) => hit.title === "Agents" && hit.section === "agents",
    ),
  ).toEqual([]);
});

test("About's Support cards are found by what they are for", () => {
  for (const query of ["star", "support", "sponsor", "donate", "github"]) {
    const titles = searchSettings(query, SETTINGS_ENTRIES).map(
      (entry) => entry.title,
    );
    expect(titles, query).toContain("Star on GitHub");
  }
  const star = SETTINGS_ENTRIES.find(
    (entry) => entry.title === "Star on GitHub",
  );
  expect(star?.section).toBe("about");
});

test("Settings search finds Buy me a coffee by purpose or provider when configured", () => {
  expect(supportEntries(null)).toEqual([]);
  const entries = supportEntries();
  for (const query of ["donate", "Ko-fi", "kofi"]) {
    expect(searchSettings(query, entries)[0]).toMatchObject({
      title: "Buy me a coffee",
      section: "about",
    });
  }
});
