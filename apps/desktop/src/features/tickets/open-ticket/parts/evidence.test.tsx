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

/** `count` records named `${prefix}${index}`. */
const records = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `${prefix}${index}`,
    kind: "branch",
    name: `${prefix}${index}`,
    value: "main",
    editing_agent: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  }));

function Probe() {
  const evidence = useOpenTicket("evidence");
  return (
    <>
      <output aria-label="count">
        {evidence.value?.items.length ?? "none"}
      </output>
      <output aria-label="first">
        {evidence.value?.items[0]?.name ?? "none"}
      </output>
      <output aria-label="more">{String(evidence.more)}</output>
      <output aria-label="failure">{evidence.failure?.title ?? "none"}</output>
      <button onClick={evidence.showMore}>Show more</button>
    </>
  );
}

const text = (label: string) => screen.getByLabelText(label).textContent;
const offsets = () =>
  bridge.invoke.mock.calls
    .filter(([command]) => command === "ticket_evidence_page")
    .map(([, args]) => (args as { offset: number }).offset);

beforeEach(() => {
  bridge.invoke.mockReset();
  bridge.invoke.mockImplementation(async () => undefined);
});
afterEach(cleanup);

it("offers more when the total exceeds the first page, and Show more reads exactly one more page", async () => {
  bridge.invoke.mockImplementation(async (_command, args) => ({
    total: 53,
    items:
      (args as { offset: number }).offset === 0
        ? records("a", 50)
        : records("b", 3),
  }));
  render(
    <TestOpenTicket ticket={ticket}>
      <Probe />
    </TestOpenTicket>,
  );
  await screen.findByText("50");
  expect(text("more")).toBe("true");
  expect(offsets()).toEqual([0]);

  await act(async () => screen.getByText("Show more").click());
  await screen.findByText("53");
  expect(text("more")).toBe("false");
  expect(offsets()).toEqual([0, 50]);
});

it("has no more when a full first page contains every record", async () => {
  bridge.invoke.mockImplementation(async () => ({
    items: records("a", 49),
    total: 49,
  }));
  render(
    <TestOpenTicket ticket={ticket}>
      <Probe />
    </TestOpenTicket>,
  );
  await screen.findByText("50");
  expect(text("more")).toBe("false");
});

it("re-reads every loaded page when the workspace changes, and keeps them all", async () => {
  const signal = fakeChangeSignal();
  let prefix = "a";
  bridge.invoke.mockImplementation(async (_command, args) => ({
    total: 52,
    items:
      (args as { offset: number }).offset === 0
        ? records(prefix, 50)
        : records(`${prefix}-more`, 2),
  }));
  render(
    <TestOpenTicket ticket={ticket} signal={signal}>
      <Probe />
    </TestOpenTicket>,
  );
  await screen.findByText("50");
  await act(async () => screen.getByText("Show more").click());
  await screen.findByText("52");
  bridge.invoke.mockClear();

  prefix = "z";
  await act(async () => signal.change());
  await screen.findByText("z0");
  expect(text("count")).toBe("52");
  expect(offsets()).toEqual([0, 50]);
});

it("keeps the records shown when a refresh fails, and says what failed", async () => {
  const signal = fakeChangeSignal();
  bridge.invoke.mockResolvedValueOnce({ items: records("a", 2), total: 2 });
  render(
    <TestOpenTicket ticket={ticket} signal={signal}>
      <Probe />
    </TestOpenTicket>,
  );
  await screen.findByText("a0");
  bridge.invoke.mockRejectedValueOnce("database busy");
  await act(async () => signal.change());
  expect(await screen.findByText("Couldn't load evidence")).toBeTruthy();
  expect(text("count")).toBe("2");
});
