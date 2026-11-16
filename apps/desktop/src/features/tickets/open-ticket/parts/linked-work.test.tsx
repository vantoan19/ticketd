// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Ticket } from "@/lib/api/client";
import { fakeChangeSignal } from "@/lib/workspace-reads/fake-signal";
import { useOpenTicket } from "..";
import { TestOpenTicket } from "../testing";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);

const ticket: Ticket = {
  id: "1",
  reference: "T-1",
  title: "Work",
  status: "Todo",
  trashed: false,
  body: "",
  project_id: null,
  plan_id: null,
  availability: null,
  tags: [],
  parent: null,
  children: [],
  prerequisites: [],
};

const item = (reference: string) => ({
  reference,
  title: { text: reference },
  status: "Todo",
  trashed: false,
  unresolved: true,
});
const page = (references: string[], next_offset: number | null = null) => ({
  items: references.map(item),
  next_offset,
});
/** The relationships the core answers, with `related` in the page given. */
function relationships(related: ReturnType<typeof page>) {
  return {
    relationships: {
      parent: null,
      children: page([]),
      children_progress: { total: 0, done: 0 },
      prerequisites: page([]),
      blocking: page([]),
      related,
      discovered_while: page([]),
      discoveries: page([]),
      duplicate_of: null,
      duplicates: page([]),
    },
  };
}

function Probe() {
  const work = useOpenTicket("linkedWork");
  const related = work.value?.related.items.map((row) => row.reference);
  return (
    <>
      <output aria-label="related">{related?.join(",") ?? "none"}</output>
      <output aria-label="more">{String(work.more)}</output>
      <output aria-label="failure">{work.failure?.title ?? "none"}</output>
      <button onClick={work.showMore}>Show more</button>
    </>
  );
}

const offsets = () =>
  bridge.invoke.mock.calls
    .filter(([command]) => command === "contextual_relationships")
    .map(([, args]) => (args as { offset: number }).offset);
const shown = () => screen.getByLabelText("related").textContent;

beforeEach(() => {
  bridge.invoke.mockReset();
  bridge.invoke.mockImplementation(async () => undefined);
});
afterEach(cleanup);

it("reads the first page, then one more on Show more, merged without repeats", async () => {
  bridge.invoke.mockImplementation(async (command, args) =>
    command !== "contextual_relationships"
      ? undefined
      : (args as { offset: number }).offset === 0
        ? relationships(page(["T-2", "T-3"], 20))
        : relationships(page(["T-3", "T-4"])),
  );
  render(
    <TestOpenTicket ticket={ticket}>
      <Probe />
    </TestOpenTicket>,
  );
  expect(await screen.findByText("T-2,T-3")).toBeTruthy();
  expect(screen.getByLabelText("more").textContent).toBe("true");

  await act(async () => screen.getByText("Show more").click());
  expect(await screen.findByText("T-2,T-3,T-4")).toBeTruthy();
  expect(screen.getByLabelText("more").textContent).toBe("false");
  expect(offsets()).toEqual([0, 20]);
});

it("re-reads every loaded page when the workspace changes, keeping them all", async () => {
  const signal = fakeChangeSignal();
  let generation = 1;
  bridge.invoke.mockImplementation(async (command, args) =>
    command !== "contextual_relationships"
      ? undefined
      : (args as { offset: number }).offset === 0
        ? relationships(page([`a${generation}`], 20))
        : relationships(page([`b${generation}`])),
  );
  render(
    <TestOpenTicket ticket={ticket} signal={signal}>
      <Probe />
    </TestOpenTicket>,
  );
  await screen.findByText("a1");
  await act(async () => screen.getByText("Show more").click());
  await screen.findByText("a1,b1");
  bridge.invoke.mockClear();

  generation = 2;
  await act(async () => signal.change());
  expect(await screen.findByText("a2,b2")).toBeTruthy();
  expect(offsets()).toEqual([0, 20]);
});

it("keeps the links shown when a refresh fails, and says it could not refresh", async () => {
  const signal = fakeChangeSignal();
  bridge.invoke.mockResolvedValueOnce(relationships(page(["T-2"])));
  render(
    <TestOpenTicket ticket={ticket} signal={signal}>
      <Probe />
    </TestOpenTicket>,
  );
  await screen.findByText("T-2");
  bridge.invoke.mockRejectedValueOnce("database busy");
  await act(async () => signal.change());
  expect(
    await screen.findByText("Couldn't refresh relationships"),
  ).toBeTruthy();
  expect(shown()).toBe("T-2");
});

it("words a first read that fails as a failure to load", async () => {
  bridge.invoke.mockImplementation(async () => {
    throw "database busy";
  });
  render(
    <TestOpenTicket ticket={ticket}>
      <Probe />
    </TestOpenTicket>,
  );
  expect(await screen.findByText("Couldn't load relationships")).toBeTruthy();
  expect(shown()).toBe("none");
});
