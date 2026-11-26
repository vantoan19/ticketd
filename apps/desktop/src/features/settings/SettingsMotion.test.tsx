// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MotionProvider } from "@/components/ui/motion";
import { SettingsView } from "@/features/settings/SettingsView";
import { SettingsNav } from "@/features/settings/SettingsNav";
import { SettingsStateProvider } from "@/features/settings/settings-state";
import type { SettingsPageId } from "@/features/settings/settings-sections";
import { agentSkillsClient } from "@/lib/api/agent-skills";
import { sourcesClient } from "@/lib/api/sources";
import {
  applyTokens,
  instantTokens,
  reducedTokens,
  rootTokens,
} from "@/test/motion-tokens";

// Settings pages: the highlight glides to the new page, and the content fades
// out before the next page arrives (DESIGN.md section 12).

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(104857600),
}));
vi.mock("@/lib/api/agent-skills", () => ({
  agentSkillsClient: { list: vi.fn(), install: vi.fn() },
}));
vi.mock("@/lib/api/notifications", () => ({
  notificationClient: {
    permission: vi.fn(async () => ({
      state: "allowed",
      reported: true,
      settings: true,
    })),
    notify: vi.fn(),
  },
}));
vi.mock("@/lib/api/sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/sources")>()),
  sourcesClient: { list: vi.fn() },
}));

let restoreTokens: () => void;
beforeEach(() => {
  vi.mocked(agentSkillsClient.list).mockResolvedValue([]);
  vi.mocked(sourcesClient.list).mockResolvedValue([]);
  restoreTokens = applyTokens(rootTokens);
});
afterEach(() => {
  cleanup();
  restoreTokens();
  localStorage.clear();
  vi.clearAllMocks();
});

function Settings() {
  const [selected, setSelected] = useState<SettingsPageId>("appearance");
  return (
    <MotionProvider>
      <SettingsStateProvider onOpenPage={setSelected}>
        <SettingsNav
          selected={selected}
          onSelect={setSelected}
          onBack={() => {}}
        />
        <SettingsView
          selected={selected}
          onSelect={setSelected}
          onRestore={async () => {}}
        />
      </SettingsStateProvider>
    </MotionProvider>
  );
}

const nav = () =>
  within(screen.getByRole("complementary", { name: "Settings" }));
const row = (name: RegExp) => nav().getByRole("button", { name });
const page = () => document.querySelector<HTMLElement>(".settings-page")!;
const title = (name: string) =>
  screen.queryByRole("heading", { level: 1, name });
const glides = () =>
  Array.from(document.querySelectorAll('[data-slot="glide"]'));

test("the highlight is one Glide that moves into the page that opens", async () => {
  render(<Settings />);
  await act(async () => {});
  expect(glides()).toHaveLength(1);
  expect(row(/^Appearance/).contains(glides()[0]!)).toBe(true);
  fireEvent.click(row(/^Attention/));
  await waitFor(() => expect(title("Attention")).toBeTruthy());
  expect(glides()).toHaveLength(1);
  expect(row(/^Attention/).contains(glides()[0]!)).toBe(true);
});

test("the open page fades out first, then the next one arrives", async () => {
  render(<Settings />);
  await act(async () => {});
  fireEvent.click(row(/^Attention/));
  // The nav answers at once; the content still shows the old page, fading.
  expect(row(/^Attention/).getAttribute("aria-current")).toBe("page");
  expect(title("Appearance")).toBeTruthy();
  expect(title("Attention")).toBeNull();
  expect(page().dataset.leaving).toBe("true");
  await waitFor(() => expect(title("Attention")).toBeTruthy());
  expect(title("Appearance")).toBeNull();
  expect(page().dataset.leaving).toBeUndefined();
});

test("the page that is fading out cannot be reached, and the next one can", async () => {
  render(<Settings />);
  await act(async () => {});
  expect(page().hasAttribute("inert")).toBe(false);
  fireEvent.click(row(/^Attention/));
  expect(page().hasAttribute("inert")).toBe(true);
  await waitFor(() => expect(title("Attention")).toBeTruthy());
  expect(page().hasAttribute("inert")).toBe(false);
});

test("the Settings page arranges its own entrance", async () => {
  render(<Settings />);
  await act(async () => {});
  expect(page().hasAttribute("data-own-entrance")).toBe(true);
});

test("the page's cascade delays its rows by whole stagger steps and only reaches the live page", () => {
  const css = readFileSync(
    join(__dirname, "layout", "settings-layout.css"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  expect(css).toMatch(
    /:not\(header\)\s*\{\s*animation-delay: var\(--stagger\);/,
  );
  // Every selector that plays the entrance starts at the live region, so the
  // shell's still picture of the page that left (a clone) never replays it.
  for (const rule of css.matchAll(/([^{}]+)\{[^{}]*animation[^{}]*\}/g))
    expect(rule[1]?.trim().replace(/\s+/g, " ")).toMatch(
      /^\.view-region(?:\[data-departing\])? \[data-own-entrance\] /,
    );
});

test("the page's cascade is held while the old page's picture is on show, by a rule that out-ranks the entrance", () => {
  const css = readFileSync(
    join(__dirname, "layout", "settings-layout.css"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
    ([, selector = "", body = ""]) => ({
      selector: selector.trim().replace(/\s+/g, " "),
      body,
    }),
  );
  const entrance = rules.find((rule) => /animation:/.test(rule.body));
  const hold = rules.find((rule) => rule.body.includes("paused"));
  expect(hold?.selector).toBe(
    ".view-region[data-departing] [data-own-entrance] .settings-shell:not([hidden]) > .settings-page-column > *",
  );
  // The hold is the entrance's selector plus the region's marker, so it wins on
  // specificity (enter.css's own hold is weaker than the entrance rule here).
  expect(hold?.selector.replace("[data-departing]", "")).toBe(
    entrance?.selector,
  );
});

test.each([
  ["reduced motion", reducedTokens],
  ["a held key or rapid clicks", instantTokens],
])("with %s the page changes at once", async (_name, tokens) => {
  restoreTokens();
  restoreTokens = applyTokens({ ...rootTokens, ...tokens });
  render(<Settings />);
  await act(async () => {});
  fireEvent.click(row(/^Attention/));
  expect(title("Attention")).toBeTruthy();
  expect(title("Appearance")).toBeNull();
  expect(page().dataset.leaving).toBeUndefined();
});
