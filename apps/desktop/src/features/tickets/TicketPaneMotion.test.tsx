// @vitest-environment jsdom
import { useEffect } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TicketWorkspaceView } from "./TicketWorkspaceView";
import { useBulkEdit } from "./useBulkEdit";
import { useTicketWorkspace } from "./useTicketWorkspace";
import type { Ticket } from "@/lib/api/client";
import { bridgeDefault } from "@/test/bridge-defaults";
import {
  applyTokens,
  instantTokens,
  reducedTokens,
  rootTokens,
} from "@/test/motion-tokens";
import { TestReads } from "@/lib/workspace-reads/testing";

// The ticket panes in the real workspace: what the state changes that start
// each motion put on the layout (DESIGN.md section 5). jsdom has no layout or
// animation, so this checks the attributes the stylesheet plays from.

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);

let restoreTokens: () => void;
type Observer = { targets: Set<Element>; callback: ResizeObserverCallback };
const observers: Observer[] = [];
/** Tickets the list holds; empty unless a test needs neighbours to move to. */
let listed: string[] = [];
/** The browser reports a pane's width: only observers watching it hear. */
function resized(id: string, width: number) {
  const pane = document.getElementById(id);
  if (!pane) throw new Error(`no pane ${id}`);
  const entry = {
    target: pane,
    contentRect: { width },
    borderBoxSize: [{ inlineSize: width, blockSize: 600 }],
  };
  act(() => {
    for (const one of observers)
      if (one.targets.has(pane))
        one.callback([entry as unknown as ResizeObserverEntry], one as never);
  });
}
const host = () => {
  const element = document.querySelector<HTMLElement>(".plan-workspace");
  if (!element) throw new Error("no host");
  return element;
};
const leavingWidth = () =>
  host().style.getPropertyValue("--pane-leaving-width");
const scrollIntoView = Element.prototype.scrollIntoView;
beforeEach(() => {
  restoreTokens = applyTokens(rootTokens);
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList,
  );
  observers.length = 0;
  listed = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      targets = new Set<Element>();
      constructor(readonly callback: ResizeObserverCallback) {
        observers.push(this);
      }
      observe(target: Element) {
        this.targets.add(target);
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
      disconnect() {
        this.targets.clear();
      }
    },
  );
  const ticket = (reference: string): Ticket => ({
    id: reference,
    reference,
    title: `Title of ${reference}`,
    status: "Todo",
    trashed: false,
    body: "Body.",
    project_id: null,
    plan_id: null,
    availability: null,
    tags: [],
    parent: null,
    children: [],
    prerequisites: [],
  });
  bridge.invoke.mockImplementation(
    async (command: string, args?: { reference?: string }) => {
      if (command === "show_ticket") return ticket(args?.reference ?? "");
      if (command === "find_tickets_with_updates") {
        const list = listed.map(ticket);
        return (args as { projection?: string }).projection
          ? { items: [], omitted: false }
          : list.map((item) => ({ ticket: item, latest_update: null }));
      }
      if (command === "count_tickets")
        return { ...(bridgeDefault(command) as object), total: listed.length };
      return bridgeDefault(command, args as { reference?: string });
    },
  );
});
afterEach(() => {
  cleanup();
  restoreTokens();
  Element.prototype.scrollIntoView = scrollIntoView;
  vi.unstubAllGlobals();
  bridge.invoke.mockReset();
});

const api: { select: (reference: string | null) => void } = {
  select: () => {},
};
function Harness() {
  const workspace = useTicketWorkspace(vi.fn(), vi.fn());
  const bulk = useBulkEdit(workspace.refresh);
  useEffect(() => {
    api.select = workspace.setSelected;
  }, [workspace.setSelected]);
  return (
    <TicketWorkspaceView
      workspace={workspace}
      bulk={bulk}
      hidden={false}
      inboxTarget={null}
      onCreate={vi.fn()}
    />
  );
}
const group = () => {
  const element = document.querySelector(".ticket-workspace");
  if (!element) throw new Error("no workspace");
  return element;
};
const open = (reference: string | null) => act(() => api.select(reference));
async function setUp() {
  render(
    <TestReads>
      <Harness />
    </TestReads>,
  );
  await waitFor(() => expect(group()).toBeTruthy());
}
function setTokens(tokens: Record<string, string>) {
  restoreTokens();
  restoreTokens = applyTokens({ ...rootTokens, ...tokens });
}

test("opening a ticket glides the document in, and the glide ends on its own", async () => {
  await setUp();
  expect(group().getAttribute("data-pane-arrival")).toBeNull();
  open("T-KQ1");
  expect(group().getAttribute("data-pane-arrival")).toBe("open");
  expect(group().getAttribute("data-pane-leaving")).toBeNull();
  await waitFor(() =>
    expect(group().getAttribute("data-pane-arrival")).toBeNull(),
  );
});

test("closing keeps the document on screen as it was while it fades out", async () => {
  await setUp();
  open("T-KQ1");
  await screen.findByText("Title of T-KQ1");
  open(null);
  expect(group().getAttribute("data-pane-leaving")).toBe("detail");
  // Not the empty state it would become, and not reachable while it leaves.
  expect(screen.queryByText("Select a ticket to read it here")).toBeNull();
  expect(screen.getByText("Title of T-KQ1")).toBeTruthy();
  expect(document.querySelector(".ticket-detail")?.hasAttribute("inert")).toBe(
    true,
  );
  // The list has the width at once; only the document is kept for its exit.
  expect(group().classList.contains("unselected")).toBe(true);
  await waitFor(() =>
    expect(group().getAttribute("data-pane-leaving")).toBeNull(),
  );
  expect(screen.getByText("Select a ticket to read it here")).toBeTruthy();
});

test("full width fades the list out while the document glides in, and back reverses it", async () => {
  await setUp();
  open("T-KQ1");
  await screen.findByText("Title of T-KQ1");
  fireEvent.click(screen.getByRole("button", { name: "Expand ticket" }));
  expect(group().getAttribute("data-pane-arrival")).toBe("expand");
  expect(group().getAttribute("data-pane-leaving")).toBe("list");
  await waitFor(() =>
    expect(group().getAttribute("data-pane-leaving")).toBeNull(),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Show beside the list" }),
  );
  expect(group().getAttribute("data-pane-arrival")).toBe("return");
});

test("J and K keep the old document one exit, then show the next with a swap arrival", async () => {
  await setUp();
  open("T-KQ1");
  await screen.findByText("Title of T-KQ1");
  open("T-KQ2");
  const pages = () => [...document.querySelectorAll(".detail-content")];
  const leaving = pages().filter((page) => page.hasAttribute("data-leaving"));
  expect(leaving).toHaveLength(1);
  // Not `hidden`: the base layer's `[hidden] { display: none !important }`
  // beats any rule here, so a hidden page could never be seen fading out.
  expect(leaving[0]?.hasAttribute("hidden")).toBe(false);
  expect(leaving[0]?.hasAttribute("inert")).toBe(true);
  expect(leaving[0]?.textContent).toContain("Title of T-KQ1");
  const next = await waitFor(() => {
    const page = pages().find((item) => item.hasAttribute("data-swap"));
    expect(page).toBeTruthy();
    return page;
  });
  expect(next?.hasAttribute("hidden")).toBe(false);
  await waitFor(() =>
    expect(document.querySelector("[data-leaving]")).toBeNull(),
  );
  // Opening from nothing is not a swap.
  open(null);
  await waitFor(() =>
    expect(group().getAttribute("data-pane-leaving")).toBeNull(),
  );
  open("T-KQ1");
  expect(document.querySelector("[data-swap]")).toBeNull();
});

test("reopening inside the close does not swap: the held document is not a ticket to move from", async () => {
  await setUp();
  open("T-KQ1");
  await screen.findByText("Title of T-KQ1");
  open(null);
  expect(group().getAttribute("data-pane-leaving")).toBe("detail");
  open("T-KQ2");
  // Closed to open plays the pane's glide alone: no old document is kept for
  // an exit and the new one waits for nothing.
  expect(group().getAttribute("data-pane-arrival")).toBe("open");
  expect(document.querySelector("[data-leaving]")).toBeNull();
  await screen.findByText("Title of T-KQ2");
  expect(document.querySelector("[data-swap]")).toBeNull();
});

test("a ticket that loads after its skeleton is marked to fade up, and a cached one is not", async () => {
  await setUp();
  open("T-KQ1");
  const loaded = await screen.findByText("Title of T-KQ1");
  expect(loaded.closest(".detail-content")?.hasAttribute("data-fresh")).toBe(
    true,
  );
  // Back to a page that stays open: no skeleton, so nothing fades up again.
  open("T-KQ2");
  await screen.findByText("Title of T-KQ2");
  open("T-KQ1");
  await waitFor(() =>
    expect(document.querySelector("[data-leaving]")).toBeNull(),
  );
  const again = screen.getByText("Title of T-KQ1");
  expect(again.closest(".detail-content")?.hasAttribute("data-fresh")).toBe(
    false,
  );
});

test.each([
  ["reduced motion", reducedTokens],
  ["a held key", instantTokens],
])("with %s every change is instant", async (_name, tokens) => {
  setTokens(tokens);
  await setUp();
  open("T-KQ1");
  await screen.findByText("Title of T-KQ1");
  expect(group().getAttribute("data-pane-arrival")).toBeNull();
  open("T-KQ2");
  expect(document.querySelector("[data-leaving]")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Expand ticket" }));
  expect(group().getAttribute("data-pane-leaving")).toBeNull();
  open(null);
  expect(group().getAttribute("data-pane-leaving")).toBeNull();
  expect(group().classList.contains("unselected")).toBe(true);
});

test("closing places the leaving document at the width the pane had, measured before the layout changed", async () => {
  await setUp();
  open("T-KQ1");
  await screen.findByText("Title of T-KQ1");
  // Split: the panes are 360 and 680 wide inside a 1040 group.
  resized("list", 360);
  resized("detail", 680);
  open(null);
  expect(group().getAttribute("data-pane-leaving")).toBe("detail");
  expect(leavingWidth()).toBe("680px");
  // The closed layout then gives the list the whole group; that is not the
  // document's width, and nothing may move the held value.
  resized("list", 1040);
  resized("detail", 1040);
  expect(leavingWidth()).toBe("680px");
  await waitFor(() => expect(leavingWidth()).toBe(""));
});

test("full width places the leaving list at the width it had", async () => {
  await setUp();
  open("T-KQ1");
  await screen.findByText("Title of T-KQ1");
  resized("list", 360);
  resized("detail", 680);
  fireEvent.click(screen.getByRole("button", { name: "Expand ticket" }));
  expect(group().getAttribute("data-pane-leaving")).toBe("list");
  expect(leavingWidth()).toBe("360px");
  resized("detail", 1040);
  expect(leavingWidth()).toBe("360px");
});

test("a pane that was never measured leaves at the group's width, not at none", async () => {
  await setUp();
  open("T-KQ1");
  await screen.findByText("Title of T-KQ1");
  open(null);
  expect(group().getAttribute("data-pane-leaving")).toBe("detail");
  expect(leavingWidth()).toBe("");
});

test.each([
  ["j", "T-KQ1", "T-KQ2", "T-KQ3"],
  ["k", "T-KQ3", "T-KQ2", "T-KQ1"],
])(
  "a held %s with focus in the document moves on every repeat",
  async (key, from, first, second) => {
    listed = ["T-KQ1", "T-KQ2", "T-KQ3"];
    await setUp();
    open(from);
    const shown = (reference: string) =>
      within(document.getElementById("detail") as HTMLElement).findByText(
        `Title of ${reference}`,
      );
    await shown(from);
    const pane = () =>
      screen.getByRole("button", { name: "Close ticket details" });
    // The first press, then the repeats the keyboard sends while it is held.
    fireEvent.keyDown(pane(), { key });
    await shown(first);
    fireEvent.keyDown(pane(), { key, repeat: true });
    await shown(second);
  },
);

test("a held Escape closes once and leaves the repeats alone", async () => {
  await setUp();
  open("T-KQ1");
  await screen.findByText("Title of T-KQ1");
  const pane = screen.getByRole("button", { name: "Close ticket details" });
  fireEvent.keyDown(pane, { key: "Escape", repeat: true });
  expect(group().classList.contains("unselected")).toBe(false);
  fireEvent.keyDown(pane, { key: "Escape" });
  expect(group().classList.contains("unselected")).toBe(true);
});

// jsdom has no cascade, so the rules that decide a pane's motion are read as
// text. The leaving document must stay out of the base layer's
// `[hidden] { display: none !important }`, and the pane arrivals carry no
// fill (they have no delay to hold the first keyframe through).
const css = (file: string) =>
  readFileSync(join(__dirname, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

test("the leaving document's rule does not depend on the hidden attribute", () => {
  const rules = css(
    "../../components/ui/surface-roles/tickets-ticket-detail.css",
  );
  expect(rules).toMatch(
    /\.detail-content\[data-leaving\]\s*\{[^}]*display:\s*grid/,
  );
  expect(rules).not.toMatch(/data-leaving\]\[hidden\]/);
});

test("the pane arrivals hold nothing beyond their own delay", () => {
  const rules = css("ticket-pane-motion.css");
  const arrivals = [
    ...rules.matchAll(/animation:\s*(ticket-(?:pane|list)-in[^;]*);/g),
  ];
  expect(arrivals.length).toBeGreaterThan(0);
  for (const [, animation] of arrivals)
    expect(animation).not.toMatch(/\b(backwards|both)\b/);
});
