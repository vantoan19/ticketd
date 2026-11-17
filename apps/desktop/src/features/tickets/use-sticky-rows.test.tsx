// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Ticket } from "@/lib/api/client";
import { useStickyRows } from "./use-sticky-rows";

const base = {
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
const ticket = (
  id: string,
  title: string,
  status: string,
  updated_at = "2026-01-01T00:00:00Z",
) =>
  ({
    ...base,
    id,
    reference: `T-${id}`,
    title,
    status,
    updated_at,
  }) as unknown as Ticket;

type Props = {
  tickets: Ticket[];
  /** The copies of Tickets known besides the list's. */
  record: Ticket | undefined;
  scopeKey: string;
  selected?: string | null;
};
const mount = (initial: Props) =>
  renderHook(
    (props: Props) =>
      useStickyRows(
        props.tickets,
        props.selected === undefined ? "T-1" : props.selected,
        (reference) =>
          props.record?.reference === reference ? props.record : undefined,
        [],
        props.scopeKey,
      ),
    { initialProps: initial },
  );
const rows = (tickets: Ticket[]) =>
  tickets.map((item) => `${item.reference}:${item.title}:${item.status}`);

afterEach(() => vi.useRealTimers());

const listed = ticket("1", "Gamma", "In progress");
const other = ticket("2", "Other", "In progress");

it("a held row the list dropped shows the newest copy of the Ticket known", () => {
  vi.useFakeTimers();
  // The person renamed it "Beta" long ago; the list has since shown "Gamma".
  const hook = mount({
    tickets: [listed, other],
    record: undefined,
    scopeKey: "a",
  });
  // An agent's change moved it out of the list. The Ticket's own read, which
  // re-reads on every change while it is shown, already has the new copy.
  const fresh = ticket("1", "Delta", "In review", "2026-01-02T00:00:00Z");
  hook.rerender({ tickets: [other], record: fresh, scopeKey: "a" });
  expect(rows(hook.result.current.tickets)).toEqual([
    "T-1:Delta:In review",
    "T-2:Other:In progress",
  ]);
  // Idle does not release a selected row, and a later reload keeps the copy.
  act(() => {
    vi.advanceTimersByTime(60_000);
  });
  hook.rerender({ tickets: [other], record: fresh, scopeKey: "a" });
  expect(rows(hook.result.current.tickets)[0]).toBe("T-1:Delta:In review");
});

it("a held row without a known record shows the list's copy", () => {
  const hook = mount({
    tickets: [listed, other],
    record: undefined,
    scopeKey: "a",
  });
  hook.rerender({ tickets: [other], record: undefined, scopeKey: "a" });
  expect(rows(hook.result.current.tickets)[0]).toBe("T-1:Gamma:In progress");
});

it("an older cached record does not replace the list's copy", () => {
  const older = ticket("1", "Beta", "Todo", "2025-12-01T00:00:00Z");
  const hook = mount({
    tickets: [listed, other],
    record: older,
    scopeKey: "a",
  });
  hook.rerender({ tickets: [other], record: older, scopeKey: "a" });
  expect(rows(hook.result.current.tickets)[0]).toBe("T-1:Gamma:In progress");
});

it("on equal times the list's copy wins over a cached copy", () => {
  // Tags and availability do not move `updated_at`, so a cached copy of the
  // same time may be older than the list's.
  const tagged = { ...listed, tags: ["cli"] };
  const cached = { ...listed, tags: [] };
  const hook = mount({
    tickets: [tagged, other],
    record: cached,
    scopeKey: "a",
  });
  hook.rerender({ tickets: [other], record: cached, scopeKey: "a" });
  expect(hook.result.current.tickets[0]?.tags).toEqual(["cli"]);
});

it("after a scope change a row is held when the newest copy has moved", () => {
  const hook = mount({
    tickets: [listed, other],
    record: undefined,
    scopeKey: "all",
  });
  hook.rerender({
    tickets: [listed, other],
    record: undefined,
    scopeKey: "search",
  });
  // The Ticket moved to In review, which the search also excludes.
  const moved = ticket("1", "Delta", "In review", "2026-01-02T00:00:00Z");
  hook.rerender({ tickets: [other], record: moved, scopeKey: "search" });
  expect(rows(hook.result.current.tickets)).toEqual([
    "T-1:Delta:In review",
    "T-2:Other:In progress",
  ]);
});

it("after a scope change a row nothing moved is not held", () => {
  const hook = mount({
    tickets: [listed, other],
    record: listed,
    scopeKey: "all",
  });
  hook.rerender({
    tickets: [listed, other],
    record: listed,
    scopeKey: "search",
  });
  hook.rerender({ tickets: [other], record: listed, scopeKey: "search" });
  expect(rows(hook.result.current.tickets)).toEqual(["T-2:Other:In progress"]);
});

it("a held row keeps the newest copy after the Ticket is deselected", () => {
  const hook = mount({
    tickets: [listed, other],
    record: listed,
    scopeKey: "a",
  });
  const fresh = ticket("1", "Gamma", "In review", "2026-01-02T00:00:00Z");
  hook.rerender({ tickets: [other], record: fresh, scopeKey: "a" });
  expect(rows(hook.result.current.tickets)[0]).toBe("T-1:Gamma:In review");
  // Escape: nothing is selected, and the row still shows what the Ticket is.
  hook.rerender({
    tickets: [other],
    record: fresh,
    scopeKey: "a",
    selected: null,
  });
  expect(rows(hook.result.current.tickets)[0]).toBe("T-1:Gamma:In review");
});

it("a held row keeps its update caption when the newest copy has none", () => {
  const summary = {
    activity_id: "a-1",
    brief: { text: "Drafted a fix", truncated: false },
    reported_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    editing_agent: "Agent",
    supporting_document_id: null,
  };
  const withSummary = {
    ...ticket("1", "Gamma", "In progress"),
    progress_summary: summary,
    latest_update: {
      activity_id: "a-1",
      reported_at: summary.reported_at,
      editing_agent: "Agent",
    },
  } as Ticket;
  const hook = mount({
    tickets: [withSummary, other],
    record: withSummary,
    scopeKey: "a",
  });
  // The Ticket's own read has no page-only summary, but names the same update.
  const fresh = {
    ...ticket("1", "Gamma", "In review", "2026-01-02T00:00:00Z"),
    latest_update: withSummary.latest_update,
  } as Ticket;
  hook.rerender({ tickets: [other], record: fresh, scopeKey: "a" });
  const held = hook.result.current.tickets[0];
  expect(held?.status).toBe("In review");
  expect(held?.progress_summary).toEqual(summary);
});

it("copies are compared as times, not as text", () => {
  // 01:00 at +02:00 is 23:00 the day before: older than the list's copy,
  // though it sorts after it as text.
  const older = ticket("1", "Beta", "Todo", "2026-01-02T01:00:00+02:00");
  const newer = ticket("1", "Gamma", "In progress", "2026-01-02T00:30:00Z");
  const hook = mount({
    tickets: [newer, other],
    record: older,
    scopeKey: "a",
  });
  hook.rerender({ tickets: [other], record: older, scopeKey: "a" });
  expect(rows(hook.result.current.tickets)[0]).toBe("T-1:Gamma:In progress");
});

it("only the open Ticket's dropped row is watched", () => {
  const hook = mount({
    tickets: [listed, other],
    record: undefined,
    scopeKey: "a",
  });
  expect(hook.result.current.watching).toBeNull();
  hook.rerender({ tickets: [other], record: undefined, scopeKey: "a" });
  expect(hook.result.current.watching).toBe("T-1");
  hook.rerender({
    tickets: [other],
    record: undefined,
    scopeKey: "a",
    selected: null,
  });
  expect(hook.result.current.watching).toBeNull();
});
