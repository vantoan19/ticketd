// @vitest-environment jsdom
import { useEffect } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
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
  // The list has the width at once.
  expect(group().classList.contains("unselected")).toBe(false);
  await waitFor(() =>
    expect(group().getAttribute("data-pane-leaving")).toBeNull(),
  );
  expect(group().classList.contains("unselected")).toBe(true);
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
  expect(leaving[0]?.hasAttribute("hidden")).toBe(true);
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
