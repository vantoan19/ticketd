// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MotionProvider } from "@/components/ui/motion";
import type { Ticket } from "@/lib/api/client";
import { TestReads } from "@/lib/workspace-reads/testing";
import { applyTokens, reducedTokens, rootTokens } from "@/test/motion-tokens";
import { TicketList } from "./TicketList";
import type { RowScope } from "./ticket-row";

// How the ticket list moves (DESIGN.md section 12). Timing comes from the real
// tokens; the motion library takes frames from the real requestAnimationFrame,
// so a motion never finishes sooner than its duration, which these tests use.

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);

const EXIT_MS = 150;

let restoreTokens: () => void;
beforeEach(() => {
  restoreTokens = applyTokens(rootTokens);
});
afterEach(() => {
  cleanup();
  restoreTokens();
  bridge.invoke.mockReset();
});

const ticket = (n: number, overrides: Partial<Ticket> = {}): Ticket => ({
  id: String(n),
  trashed: false,
  reference: `T-KQ${n}`,
  title: `Ticket ${n}`,
  status: "Todo",
  body: "",
  tags: [],
  project_id: null,
  plan_id: null,
  availability: "Ready",
  parent: null,
  children: [],
  duplicate_of: null,
  duplicates: [],
  prerequisites: [],
  ...overrides,
});
const scope: RowScope = {
  showPlan: true,
  showProject: true,
  plans: [],
  projects: [],
};

function List({
  tickets,
  selected = null,
  empty,
}: {
  tickets: Ticket[];
  selected?: string | null;
  empty?: string;
}) {
  return (
    <MotionProvider>
      <TestReads>
        <TicketList
          tickets={tickets}
          selected={selected}
          onOpen={vi.fn()}
          bulkSelection={[]}
          onToggle={vi.fn()}
          selectable
          scope={scope}
          {...(empty && { empty: <p>{empty}</p> })}
        />
      </TestReads>
    </MotionProvider>
  );
}

function useReducedMotion() {
  restoreTokens();
  restoreTokens = applyTokens({ ...rootTokens, ...reducedTokens });
}

function holdKey() {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "j", repeat: true }),
    );
  });
}

/** Milliseconds until the text has left the document. */
async function leaves(text: string): Promise<number> {
  const start = performance.now();
  await waitFor(() => expect(screen.queryByText(text)).toBeNull(), {
    interval: 4,
  });
  return performance.now() - start;
}

const rowOf = (title: string) => screen.getByText(title).closest("li")!;

test("a created row starts soft and below its place, with its space closed", () => {
  const { rerender } = render(<List tickets={[ticket(1)]} />);
  expect(rowOf("Ticket 1").style.opacity).toBe("1");
  rerender(<List tickets={[ticket(1), ticket(2)]} />);
  const { opacity, transform, filter, height } = rowOf("Ticket 2").style;
  expect(opacity).toBe("0");
  expect(transform).toContain("translateY(6px)");
  expect(filter).toBe("blur(4px)");
  expect(height).toBe("0px");
});

test("a created row settles into place", async () => {
  const { rerender } = render(<List tickets={[ticket(1)]} />);
  rerender(<List tickets={[ticket(1), ticket(2)]} />);
  await waitFor(() => expect(rowOf("Ticket 2").style.opacity).toBe("1"));
});

test("a trashed row stays while it fades and its space closes", async () => {
  const { rerender } = render(<List tickets={[ticket(1), ticket(2)]} />);
  rerender(<List tickets={[ticket(1)]} />);
  expect(screen.queryByText("Ticket 2")).not.toBeNull();
  expect(await leaves("Ticket 2")).toBeGreaterThanOrEqual(EXIT_MS - 10);
});

test("a trashed row leaves at once under reduced motion", async () => {
  useReducedMotion();
  const { rerender } = render(<List tickets={[ticket(1), ticket(2)]} />);
  rerender(<List tickets={[ticket(1)]} />);
  expect(await leaves("Ticket 2")).toBeLessThan(EXIT_MS - 10);
});

test("a trashed row leaves at once while a key repeats", async () => {
  const { rerender } = render(<List tickets={[ticket(1), ticket(2)]} />);
  holdKey();
  rerender(<List tickets={[ticket(1)]} />);
  expect(await leaves("Ticket 2")).toBeLessThan(EXIT_MS - 10);
});

test("the open ticket's highlight is one element that follows the open ticket", () => {
  const tickets = [ticket(1), ticket(2)];
  const { rerender } = render(<List tickets={tickets} selected="T-KQ1" />);
  const highlight = () => document.querySelectorAll('[data-slot="glide"]');
  expect(highlight()).toHaveLength(1);
  expect(rowOf("Ticket 1").contains(highlight()[0]!)).toBe(true);
  rerender(<List tickets={tickets} selected="T-KQ2" />);
  expect(highlight()).toHaveLength(1);
  expect(rowOf("Ticket 2").contains(highlight()[0]!)).toBe(true);
});

test("a released row shows the arrival fill once it is let go", () => {
  const { rerender } = render(<List tickets={[ticket(1), ticket(2)]} />);
  const row = rowOf("Ticket 1");
  fireEvent.pointerEnter(row);
  rerender(<List tickets={[ticket(1, { status: "Done" }), ticket(2)]} />);
  // Held where it was while the pointer is on it.
  expect(row.querySelector('[data-slot="arrival"]')).toBeNull();
  fireEvent.pointerLeave(row);
  fireEvent.click(document.body);
  const fill = row.querySelector('[data-slot="arrival"]');
  expect(fill).not.toBeNull();
  expect(row.getAttribute("data-arriving")).toBe("true");
});

test("no ticket is highlighted until one is open", () => {
  render(<List tickets={[ticket(1)]} />);
  expect(document.querySelector('[data-slot="glide"]')).toBeNull();
});

test("the empty state fades up once the last row is gone", async () => {
  const { rerender } = render(
    <List tickets={[ticket(1)]} empty="No tickets match" />,
  );
  expect(screen.queryByText("No tickets match")).toBeNull();
  rerender(<List tickets={[]} empty="No tickets match" />);
  const state = screen
    .getByText("No tickets match")
    .closest('[data-slot="appear"]') as HTMLElement;
  expect(state.style.opacity).toBe("0");
  expect(state.style.filter).toBe("blur(4px)");
  await waitFor(() => expect(state.style.opacity).toBe("1"));
  await leaves("Ticket 1");
});

test("an empty list shows its empty state at once, without fading in", () => {
  render(<List tickets={[]} empty="Nothing here yet" />);
  expect(screen.getByText("Nothing here yet")).toBeTruthy();
  const state = screen
    .getByText("Nothing here yet")
    .closest<HTMLElement>('[data-slot="appear"]');
  expect(state?.style.opacity).not.toBe("0");
});
