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
    permitted: vi.fn().mockResolvedValue(false),
    requestPermission: vi.fn(),
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
          onOpenInbox={() => {}}
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
