import { expect, test } from "vitest";
import {
  SETTINGS_SECTIONS,
  initialSettingsPage,
  navSectionOf,
  resolveSettingsPage,
} from "./settings-sections";

test("the pages are the decided ones, each with a job line of its own", () => {
  expect(SETTINGS_SECTIONS.map(({ id }) => id)).toEqual([
    "setup",
    "appearance",
    "attention",
    "workspace-sync",
    "files",
    "backups-export",
    "command-line",
    "agent-skills",
    "agents",
    "automations",
    "ticket-sources",
    "keyboard-shortcuts",
    "diagnostics",
    "about",
  ]);
  const jobs = SETTINGS_SECTIONS.map(({ job }) => job);
  expect(new Set(jobs).size).toBe(jobs.length);
  expect(jobs.every((job) => job.endsWith("."))).toBe(true);
});

test("a page asked for by an old name lands on the page that took its content", () => {
  const landing = (name: string) => resolveSettingsPage(name);
  expect(landing("attachments")).toBe("files");
  expect(landing("google-drive")).toBe("files");
  expect(landing("location")).toBe("backups-export");
  expect(landing("backups")).toBe("backups-export");
  expect(landing("export")).toBe("backups-export");
  expect(landing("chat")).toBe("agents");
  expect(landing("sources")).toBe("ticket-sources");
});

test("current names, Search and a connection stay as they are; a name nobody knows opens Appearance", () => {
  expect(resolveSettingsPage("agent-skills")).toBe("agent-skills");
  expect(resolveSettingsPage("search")).toBe("search");
  expect(resolveSettingsPage("source-github-2")).toBe("source-github-2");
  expect(resolveSettingsPage("nonsense")).toBe("appearance");
});

test("a connection selects Ticket sources in the sidebar and Search selects nothing", () => {
  expect(navSectionOf("source-github")).toBe("ticket-sources");
  expect(navSectionOf("search")).toBeNull();
  expect(navSectionOf("about")).toBe("about");
});

test("Settings opens on Set up ticketd while it is neither finished nor hidden, else on Appearance", () => {
  expect(initialSettingsPage({ setupPending: true })).toBe("setup");
  expect(initialSettingsPage({ setupPending: false })).toBe("appearance");
});

test("Set up ticketd is a page of its own, selected in the sidebar by its own row", () => {
  expect(resolveSettingsPage("setup")).toBe("setup");
  expect(navSectionOf("setup")).toBe("setup");
});
