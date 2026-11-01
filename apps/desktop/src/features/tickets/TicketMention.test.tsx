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
});

const ticket = (reference: string, body: string, trashed = false): Ticket => ({
  id: reference,
  reference,
  title: reference === "T-1" ? "Target" : "Source",
  status: "Todo",
  trashed,
  body,
  project_id: null,
  effort_id: null,
  availability: null,
  tags: [],
  parent: null,
  children: [],
  prerequisites: [],
});

// What the workspace stored before a CLI edit, and what the database holds now. The
// backlink's span was computed on the stored text.
const OLD = "Intro.\n\nBlocked on T-1 today.";
const STORED = "Added first.\n\nIntro.\n\nBlocked on T-1 today.";
const span = {
  mention_start: STORED.indexOf("T-1"),
  mention_end: STORED.indexOf("T-1") + 3,
};

type Api = { select: (reference: string) => void };
const api: Api = { select: () => {} };
let show: (reference: string) => Promise<Ticket>;
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
          return args?.reference === "T-1"
            ? [
                {
                  source_reference: "T-2",
                  source_title: "Source",
                  note_id: null,
                  created_at: null,
                  passage: "Blocked on T-1 today.",
                  ...span,
                },
              ]
            : [];
        case "get_note":
          return null;
        // A token that never moves: the Backlinks and Linked work reads are
        // skipped after the first, yet following a mention must still reveal it.
        case "change_token":
          return 1;
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
async function followBacklink() {
  render(<Harness />);
  // Cache T-2 with its old body, then look at T-1, whose backlinks list T-2.
  act(() => api.select("T-2"));
  await screen.findByText(/Blocked on T-1 today\./, { selector: "p" });
  act(() => api.select("T-1"));
  fireEvent.click(await screen.findByRole("button", { name: /Source/ }));
}

test("a mention waits for the fresh body, so a stale cache neither misses nor loses the highlight", async () => {
  let fresh = false;
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  setUp(async (reference) => {
    if (reference === "T-1") return ticket("T-1", "Plain.");
    if (!fresh) return ticket("T-2", OLD);
    await gate;
    return ticket("T-2", STORED);
  });
  render(<Harness />);
  act(() => api.select("T-2"));
  await screen.findByText(/Blocked on T-1 today\./, { selector: "p" });
  act(() => api.select("T-1"));
  fresh = true;
  fireEvent.click(await screen.findByRole("button", { name: /Source/ }));
  // The cached body is on screen, but nothing is revealed or reported yet.
  expect(marked()).toBeNull();
  expect(document.querySelector("[id^=mention-note]")?.textContent).toBe("");
  await act(async () => release());
  await waitFor(() =>
    expect(marked()?.textContent).toBe("Blocked on T-1 today."),
  );
  expect(document.activeElement).toBe(marked());
  expect(document.getElementById("mention-note-T-2")?.textContent).toBe(
    "Mentions T-1",
  );
});

test("trashing and restoring the revealed ticket does not reveal it again", async () => {
  let current = ticket("T-2", STORED);
  setUp(async (reference) =>
    reference === "T-1" ? ticket("T-1", "Plain.") : current,
  );
  await followBacklink();
  await waitFor(() => expect(marked()).not.toBeNull());
  current = ticket("T-2", STORED, true);
  await waitFor(() => expect(marked()).toBeNull(), { timeout: 4000 });
  current = ticket("T-2", STORED, false);
  await waitFor(
    () =>
      expect(
        document.querySelector(".detail-content:not([hidden]) textarea"),
      ).not.toBeNull(),
    { timeout: 4000 },
  );
  expect(marked()).toBeNull();
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
}, 15000);

test("switching to another view and back drops the highlight", async () => {
  setUp(async (reference) =>
    reference === "T-1" ? ticket("T-1", "Plain.") : ticket("T-2", STORED),
  );
  await followBacklink();
  await waitFor(() => expect(marked()).not.toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Leave" }));
  fireEvent.click(screen.getByRole("button", { name: "Return" }));
  await waitFor(() => expect(marked()).toBeNull());
});

test("selecting the ticket that is already open drops the highlight", async () => {
  setUp(async (reference) =>
    reference === "T-1" ? ticket("T-1", "Plain.") : ticket("T-2", STORED),
  );
  await followBacklink();
  await waitFor(() => expect(marked()).not.toBeNull());
  act(() => api.select("T-2"));
  await waitFor(() => expect(marked()).toBeNull());
});
