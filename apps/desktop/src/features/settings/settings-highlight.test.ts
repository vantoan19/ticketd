// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  HIGHLIGHT_MS,
  findSetting,
  showSetting,
} from "@/features/settings/settings-highlight";

let root: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  root = document.createElement("div");
  root.innerHTML = `
    <div class="settings-panel-bar"><nav><ol><li>Theme</li></ol></nav></div>
    <header class="settings-page-header"><h1>Theme</h1></header>
    <section class="settings-section"><h2>Looks</h2>
      <div class="settings-list">
        <div class="settings-list-row" id="theme"><div><div class="settings-list-row-title">Theme</div>
          <div class="settings-list-row-description">System follows your operating system</div></div></div>
        <div class="settings-list-row" id="open"><div class="settings-list-row-title">Open <b>tickets</b></div></div>
      </div>
    </section>
    <div hidden><div class="settings-list-row" id="hidden"><div>Discovery</div></div></div>`;
  document.body.append(root);
});
afterEach(() => {
  root.remove();
  vi.useRealTimers();
});

test("a setting is found by the title its page shows, grown to its row", () => {
  expect(findSetting(root, "Theme")?.id).toBe("theme");
  expect(findSetting(root, "Open tickets")?.id).toBe("open");
  expect(findSetting(root, "  open   TICKETS ")?.id).toBe("open");
  expect(findSetting(root, "Looks")?.className).toBe("settings-section");
});

test("the page's own heading and pages that are kept hidden never match", () => {
  const rows = root.querySelectorAll("#theme");
  expect(findSetting(root, "Theme")).toBe(rows[0]);
  expect(findSetting(root, "Discovery")).toBeNull();
  expect(findSetting(root, "Nothing like it")).toBeNull();
});

test("showing a setting marks it for about three seconds and scrolls it into view", () => {
  const scrolled = vi.fn();
  const row = root.querySelector("#theme") as HTMLElement;
  row.scrollIntoView = scrolled;
  showSetting(root, "Theme");
  expect(row.hasAttribute("data-found")).toBe(true);
  expect(scrolled).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(HIGHLIGHT_MS - 1);
  expect(row.hasAttribute("data-found")).toBe(true);
  vi.advanceTimersByTime(1);
  expect(row.hasAttribute("data-found")).toBe(false);
  expect(HIGHLIGHT_MS).toBe(3000);
});

test("a setting that arrives after its page has loaded is shown then", async () => {
  showSetting(root, "Late row");
  expect(root.querySelector("[data-found]")).toBeNull();
  const late = document.createElement("div");
  late.className = "settings-list-row";
  late.textContent = "Late row";
  root.append(late);
  await vi.advanceTimersByTimeAsync(0);
  await Promise.resolve();
  expect(late.hasAttribute("data-found")).toBe(true);
});

test("undoing it takes the mark off at once", () => {
  const stop = showSetting(root, "Theme");
  const row = root.querySelector("#theme") as HTMLElement;
  stop();
  expect(row.hasAttribute("data-found")).toBe(false);
});
