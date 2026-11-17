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
  record: Ticket | undefined;
  scopeKey: string;
};
const mount = (initial: Props) =>
  renderHook(
    (props: Props) =>
      useStickyRows(props.tickets, "T-1", props.record, [], props.scopeKey),
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
