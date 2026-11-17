// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { MotionProvider } from "@/components/ui/motion";
import { Inbox } from "./Inbox";
import { useNewEntries } from "./inbox-arrivals";
import { UnreadDot } from "./inbox-motion";
import type { Entry } from "./inboxModel";
import { frames } from "@/test/motion-clock";
import { EXIT_MS, holdKey, motionTestbed } from "@/test/motion-testbed";

// Inbox entries (DESIGN.md section 12): a new entry opens its space and fades
// up; marked read, the unread dot shrinks away in the exit time. Entries that
// were already shown, and pages added by "Show more", do not animate.

let store: Entry[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "set_inbox_read") {
      const ids = args.ids as number[];
      store = store.map((e) =>
        ids.includes(e.id) ? { ...e, read: args.read as boolean } : e,
      );
    }
    if (command === "inbox") {
      const offset = args.offset as number;
      const limit = args.limit as number;
      return store
        .filter((e) => !args.unreadOnly || !e.read)
        .slice(offset, offset + limit);
    }
  }),
}));

const entry = (id: number): Entry => ({
  id,
  reference: `T-KQ${id}`,
  title: `Ticket ${id}`,
  kind: "status",
  from_value: "Todo",
  to_value: "Done",
  timestamp: new Date().toISOString(),
  read: false,
  editing_agent: null,
});

const testbed = motionTestbed();
beforeEach(() => {
  store = [entry(1), entry(2)];
});

const slot = (title: string) =>
  screen.getByText(title).closest<HTMLElement>("li")!;

test("an entry that arrives opens its space soft and small; the others stay put", async () => {
  const view = (revision: number) => (
    <MotionProvider>
      <Inbox revision={revision} select={vi.fn()} onBrowse={vi.fn()} />
    </MotionProvider>
  );
  const { rerender, container } = render(view(0));
  await screen.findByText("Ticket 1");
  expect(slot("Ticket 1").style.opacity).not.toBe("0");

  // The slot is caught as it is inserted, before its motion has run.
  const inserted: [text: string, style: string][] = [];
  new MutationObserver((records) => {
    for (const node of records.flatMap((r) => [...r.addedNodes]))
      if (node instanceof HTMLLIElement)
        inserted.push([node.textContent ?? "", node.getAttribute("style")!]);
  }).observe(container, { childList: true, subtree: true });
  store = [entry(3), ...store];
  rerender(view(1));
  await screen.findByText("Ticket 3");
  expect(inserted).toHaveLength(1);
  expect(inserted[0]?.[0]).toContain("Ticket 3");
  expect(inserted[0]?.[1]).toContain("height: 0px");
  expect(inserted[0]?.[1]).toContain("opacity: 0");
  expect(inserted[0]?.[1]).toContain("blur(4px)");
});

test("entries are marked as rows for a page arrival, and rest with no blur filter", async () => {
  render(
    <MotionProvider>
      <Inbox revision={0} select={vi.fn()} onBrowse={vi.fn()} />
    </MotionProvider>,
  );
  await screen.findByText("Ticket 1");
  for (const title of ["Ticket 1", "Ticket 2"]) {
    expect(slot(title).getAttribute("data-arrive")).toBe("row");
    // A resting blur(0px) would keep a compositing layer on every row.
    expect(slot(title).style.filter).not.toBe("blur(0px)");
  }
});

test("an entry that arrives settles with no blur filter either", async () => {
  testbed.realTime();
  const view = (revision: number) => (
    <MotionProvider>
      <Inbox revision={revision} select={vi.fn()} onBrowse={vi.fn()} />
    </MotionProvider>
  );
  const { rerender } = render(view(0));
  await screen.findByText("Ticket 1");
  store = [entry(3), ...store];
  rerender(view(1));
  await screen.findByText("Ticket 3");
  await waitFor(
    () => {
      expect(slot("Ticket 3").style.opacity).toBe("1");
      expect(slot("Ticket 3").style.filter).toBe("none");
    },
    { timeout: 10_000 },
  );
});

function Dot({ read }: { read: boolean }) {
  return (
    <MotionProvider>
      <UnreadDot read={read} />
    </MotionProvider>
  );
}

test("marked read, the unread dot shrinks away in the exit time, not before", async () => {
  const { container, rerender } = render(<Dot read={false} />);
  const mark = () => container.querySelector("span");
  expect(mark()).not.toBeNull();
  rerender(<Dot read />);
  await frames();
  expect(mark()).not.toBeNull();
  await testbed.advance(EXIT_MS - 10);
  expect(mark()).not.toBeNull();
  await testbed.advance(20);
  expect(mark()).toBeNull();
});

test("under reduced motion the dot goes at once", async () => {
  testbed.reduceMotion();
  const { container, rerender } = render(<Dot read={false} />);
  rerender(<Dot read />);
  await frames();
  expect(container.querySelector("span")).toBeNull();
});

test("while a key repeats the dot goes at once", async () => {
  const { container, rerender } = render(<Dot read={false} />);
  await frames();
  holdKey();
  rerender(<Dot read />);
  await frames();
  expect(container.querySelector("span")).toBeNull();
});

test("opening an entry marks it read and its dot goes", async () => {
  // The dot leaves in its own time; this waits for the state, not a duration.
  testbed.realTime();
  render(
    <MotionProvider>
      <Inbox revision={0} select={vi.fn()} onBrowse={vi.fn()} />
    </MotionProvider>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: /T-KQ1.*Ticket 1/ }),
  );
  await waitFor(() => expect(store[0]?.read).toBe(true));
  await waitFor(() =>
    expect(slot("Ticket 1").querySelector(".inbox-dot")?.children).toHaveLength(
      0,
    ),
  );
});

// What each render of `Arrivals` was told, in order.
let told: string[] = [];

function Arrivals({
  keys,
  settled = true,
  pages = 1,
}: {
  keys: string[];
  settled?: boolean;
  pages?: number;
}) {
  const arrived = useNewEntries(keys, settled, pages);
  told.push([...arrived].join(","));
  return null;
}

test("nothing is new on the first settled render; a later key is, in the render that shows it", () => {
  told = [];
  const { rerender } = render(<Arrivals keys={["a", "b"]} />);
  expect(told.every((arrived) => arrived === "")).toBe(true);
  told = [];
  rerender(<Arrivals keys={["c", "a", "b"]} />);
  expect(told.at(-1)).toBe("c");
});

test("keys that arrive while loading, or with Show more, are not new", () => {
  told = [];
  const { rerender } = render(<Arrivals keys={[]} settled={false} />);
  rerender(<Arrivals keys={["a"]} settled={false} />);
  rerender(<Arrivals keys={["a"]} />);
  rerender(<Arrivals keys={["a", "b", "c"]} pages={2} />);
  expect(told.every((arrived) => arrived === "")).toBe(true);
});
