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
  // Names every object inherits are not pages either.
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"])
    expect(resolveSettingsPage(name)).toBe("appearance");
});

test("a connection selects Ticket sources in the sidebar, an agent selects Agents, and Search selects nothing", () => {
  expect(navSectionOf("source-github")).toBe("ticket-sources");
  expect(navSectionOf("agent:claude-code")).toBe("agents");
  expect(resolveSettingsPage("agent:codex")).toBe("agent:codex");
  // A section whose id starts like an agent page is still its own page.
  expect(navSectionOf("agent-skills")).toBe("agent-skills");
  expect(navSectionOf("search")).toBeNull();
  expect(navSectionOf("about")).toBe("about");
});

test("Settings opens on Set up ticketd while it is neither finished nor hidden, else on Appearance", () => {
  expect(initialSettingsPage({ setupPending: true })).toBe("setup");
  expect(initialSettingsPage({ setupPending: false })).toBe("appearance");
});

test("a last page the sidebar hides now is not come back to", () => {
  // Automations is listed only while Chats are on.
  expect(
    initialSettingsPage({
      setupPending: false,
      last: "automations",
      chatsOn: false,
    }),
  ).toBe("appearance");
  expect(
    initialSettingsPage({
      setupPending: false,
      last: "automations",
      chatsOn: true,
    }),
  ).toBe("automations");
});

test("Settings opens on the page that needs the person before anything else", () => {
  expect(
    initialSettingsPage({
      setupPending: true,
      needs: "workspace-sync",
      last: "files",
    }),
  ).toBe("workspace-sync");
  expect(
    initialSettingsPage({ setupPending: false, needs: "ticket-sources" }),
  ).toBe("ticket-sources");
});

test("with nothing to fix, Settings opens on the page last used, once Set up ticketd is out of the way", () => {
  expect(initialSettingsPage({ setupPending: false, last: "files" })).toBe(
    "files",
  );
  // Set up ticketd comes first while it is unfinished.
  expect(initialSettingsPage({ setupPending: true, last: "files" })).toBe(
    "setup",
  );
  // An old name resolves; a page that is gone, Search or a thing opened in place is not come back to.
  expect(initialSettingsPage({ setupPending: false, last: "chat" })).toBe(
    "agents",
  );
  expect(initialSettingsPage({ setupPending: false, last: "setup" })).toBe(
    "appearance",
  );
  expect(initialSettingsPage({ setupPending: false, last: "search" })).toBe(
    "appearance",
  );
  expect(
    initialSettingsPage({ setupPending: false, last: "agent:codex" }),
  ).toBe("appearance");
  expect(
    initialSettingsPage({ setupPending: false, last: "source-github" }),
  ).toBe("appearance");
  expect(initialSettingsPage({ setupPending: false, last: "nonsense" })).toBe(
    "appearance",
  );
  expect(initialSettingsPage({ setupPending: false, last: null })).toBe(
    "appearance",
  );
});

test("Set up ticketd is a page of its own, selected in the sidebar by its own row", () => {
  expect(resolveSettingsPage("setup")).toBe("setup");
  expect(navSectionOf("setup")).toBe("setup");
});
