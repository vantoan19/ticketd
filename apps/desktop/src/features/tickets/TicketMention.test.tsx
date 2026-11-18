// @vitest-environment jsdom
import { useEffect, useState } from "react";
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
import { TickingChanges } from "@/test/ticking-changes";
import { fakeChangeSignal } from "@/lib/workspace-reads/fake-signal";
import { TestReads } from "@/lib/workspace-reads/testing";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);

const scrollIntoView = Element.prototype.scrollIntoView;
beforeEach(() => {
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
});
afterEach(() => {
  cleanup();
  Element.prototype.scrollIntoView = scrollIntoView;
  vi.unstubAllGlobals();
  bridge.invoke.mockReset();
  listStamp = 0;
});

const ticket = (reference: string, body: string, trashed = false): Ticket => ({
  id: reference,
  reference,
  title: reference === "T-KQ1" ? "Target" : "Source",
  status: "Todo",
  trashed,
  body,
  project_id: null,
  plan_id: null,
  availability: null,
  tags: [],
  parent: null,
  children: [],
  prerequisites: [],
});

// What the workspace stored before a CLI edit, and what the database holds now. The
// backlink's span was computed on the stored text.
const OLD = "Intro.\n\nBlocked on T-KQ1 today.";
const STORED = "Added first.\n\nIntro.\n\nBlocked on T-KQ1 today.";
const span = {
  mention_start: STORED.indexOf("T-KQ1"),
  mention_end: STORED.indexOf("T-KQ1") + 3,
};

type Api = { select: (reference: string) => void };
const api: Api = { select: () => {} };
let show: (reference: string) => Promise<Ticket>;
let listStamp = 0;
function Harness() {
  const workspace = useTicketWorkspace(vi.fn(), vi.fn());
  const bulk = useBulkEdit(workspace.refresh);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    api.select = workspace.setSelected;
  }, [workspace.setSelected]);
  return (
    <>
      <button type="button" onClick={() => setHidden(true)}>
        Leave
      </button>
      <button type="button" onClick={() => setHidden(false)}>
        Return
      </button>
      <TicketWorkspaceView
        workspace={workspace}
        bulk={bulk}
        hidden={hidden}
        inboxTarget={null}
        onCreate={vi.fn()}
      />
    </>
  );
}
function setUp(showTicket: (reference: string) => Promise<Ticket>) {
  show = showTicket;
  bridge.invoke.mockImplementation(
    async (command: string, args?: { reference?: string }) => {
      switch (command) {
        case "show_ticket":
          return show(args?.reference ?? "");
        case "ticket_backlinks":
          return args?.reference === "T-KQ1"
            ? [
                {
                  source_reference: "T-KQ2",
                  source_title: "Source",
                  activity_id: null,
                  reported_at: null,
                  passage: "Blocked on T-KQ1 today.",
                  ...span,
                },
              ]
            : [];
        case "find_tickets_with_updates":
          // Something else changed in the workspace, as a real edit would show.
          return listStamp > 0
            ? [
                {
                  ticket: ticket("T-KQ9", String(listStamp)),
                  latest_update: null,
                },
              ]
            : [];
        case "count_tickets":
          return bridgeDefault(command);
        case "get_note":
          return null;
        case "is_following":
          return false;
        case "reminder":
          return null;
        case "sidebar_counts":
          return { unread_inbox: 0, ready: 0, in_progress: 0 };
        default:
          return [];
      }
    },
  );
}
const marked = () => document.querySelector("[data-mention-target]");
/** The body paragraph, whose reference is its own element (a RecordLink). */
const passage = (_: string, element: Element | null) =>
  element?.tagName === "P" &&
  /^Blocked on T-KQ1 today\.$/.test(element.textContent ?? "");
async function followBacklink() {
  render(
    <TickingChanges>
      <Harness />
    </TickingChanges>,
  );
  // Cache T-KQ2 with its old body, then look at T-KQ1, whose backlinks list T-KQ2.
  act(() => api.select("T-KQ2"));
  await screen.findByText(passage);
  act(() => api.select("T-KQ1"));
  fireEvent.click(await screen.findByRole("button", { name: /Source/ }));
}

test("a mention waits for the fresh body, so a stale cache neither misses nor loses the highlight", async () => {
  let fresh = false;
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  setUp(async (reference) => {
    if (reference === "T-KQ1") return ticket("T-KQ1", "Plain.");
    if (!fresh) return ticket("T-KQ2", OLD);
    await gate;
    return ticket("T-KQ2", STORED);
  });
  const signal = fakeChangeSignal();
  render(
    <TestReads signal={signal}>
      <Harness />
    </TestReads>,
  );
  act(() => api.select("T-KQ2"));
  await screen.findByText(passage);
  act(() => api.select("T-KQ1"));
  // A CLI edit changes the body while T-KQ2 is hidden, and the poll has not
  // noticed yet: following the mention still judges it against a fresh read.
  fresh = true;
  fireEvent.click(await screen.findByRole("button", { name: /Source/ }));
  // The cached body is on screen, but nothing is revealed or reported yet.
  expect(marked()).toBeNull();
  expect(document.querySelector("[id^=mention-note]")?.textContent).toBe("");
  await act(async () => release());
  await waitFor(() =>
    expect(marked()?.textContent).toBe("Blocked on T-KQ1 today."),
  );
  expect(document.activeElement).toBe(marked());
  expect(document.getElementById("mention-note-T-KQ2")?.textContent).toBe(
    "Mentions T-KQ1",
  );
});

test("a mention waits for the fresh body when a reported change has made the cached one stale", async () => {
  let fresh = false;
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  setUp(async (reference) => {
    if (reference === "T-KQ1") return ticket("T-KQ1", "Plain.");
    if (!fresh) return ticket("T-KQ2", OLD);
    await gate;
    return ticket("T-KQ2", STORED);
  });
  const signal = fakeChangeSignal();
  render(
    <TestReads signal={signal}>
      <Harness />
    </TestReads>,
  );
  act(() => api.select("T-KQ2"));
  await screen.findByText(passage);
  act(() => api.select("T-KQ1"));
  // A CLI edit changes the body while T-KQ2 is hidden, and the poll reports it:
  // its cached copy is stale, and not read again until it is shown.
  fresh = true;
  await act(async () => signal.change());
  fireEvent.click(await screen.findByRole("button", { name: /Source/ }));
  expect(marked()).toBeNull();
  await act(async () => release());
  await waitFor(() =>
    expect(marked()?.textContent).toBe("Blocked on T-KQ1 today."),
  );
});

test("trashing and restoring the revealed ticket does not reveal it again", async () => {
  let current = ticket("T-KQ2", STORED);
  setUp(async (reference) =>
    reference === "T-KQ1" ? ticket("T-KQ1", "Plain.") : current,
  );
  await followBacklink();
  await waitFor(() => expect(marked()).not.toBeNull());
  const scroller = document.querySelector<HTMLElement>(".detail-scroll")!;
  scroller.scrollTop = 33;
  current = ticket("T-KQ2", STORED, true);
  listStamp = 1;
  await waitFor(() => expect(marked()).toBeNull(), { timeout: 4000 });
  current = ticket("T-KQ2", STORED, false);
  listStamp = 2;
  await waitFor(
    () =>
      expect(
        document.querySelector(".detail-content:not([hidden]) textarea"),
      ).not.toBeNull(),
    { timeout: 4000 },
  );
  expect(marked()).toBeNull();
  expect(scroller.scrollTop).toBe(33);
}, 15000);

test("switching to another view and back drops the highlight", async () => {
  setUp(async (reference) =>
    reference === "T-KQ1" ? ticket("T-KQ1", "Plain.") : ticket("T-KQ2", STORED),
  );
  await followBacklink();
  await waitFor(() => expect(marked()).not.toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Leave" }));
  fireEvent.click(screen.getByRole("button", { name: "Return" }));
  await waitFor(() => expect(marked()).toBeNull());
});

test("selecting the ticket that is already open drops the highlight", async () => {
  setUp(async (reference) =>
    reference === "T-KQ1" ? ticket("T-KQ1", "Plain.") : ticket("T-KQ2", STORED),
  );
  await followBacklink();
  await waitFor(() => expect(marked()).not.toBeNull());
  act(() => api.select("T-KQ2"));
  await waitFor(() => expect(marked()).toBeNull());
});
