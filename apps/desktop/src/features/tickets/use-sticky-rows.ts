import { useEffect, useRef, useState } from "react";
import type { Ticket } from "@/lib/api/client";

type Placement = { status: string; index: number; ticket: Ticket };

/** Keep the ledger's reading position while the saved properties update. */
export function useStickyRows(
  tickets: Ticket[],
  selected: string | null,
  details: Record<string, Ticket>,
  bulkSelection: string[],
  scopeKey: string,
) {
  const [previousScope, setPreviousScope] = useState(scopeKey);
  const [allowMissing, setAllowMissing] = useState(true);
  const [focused, setFocused] = useState<string | null>(null);
  const [source, setSource] = useState(tickets);
  const [held, setHeld] = useState(new Map<string, Placement>());
  const [arrivals, setArrivals] = useState(new Set<string>());
  const [previousSelected, setPreviousSelected] = useState(selected);
  const wake = useRef<() => void>(() => {});
  const hovered = useRef<string | null>(null);
  const release = () => {
    setHeld((previous) => {
      if (previous.size) setArrivals(new Set(previous.keys()));
      return previous.size ? new Map() : previous;
    });
  };
  if (previousScope !== scopeKey) {
    setPreviousScope(scopeKey);
    setAllowMissing(false);
    if (held.size) setHeld(new Map());
  }
  if (previousSelected !== selected) {
    setAllowMissing(true);
    setPreviousSelected(selected);
    if (held.size) {
      setArrivals(new Set(held.keys()));
      setHeld(new Map());
    }
  }
  if (source !== tickets) {
    const next = new Map(
      previousSelected === selected && previousScope === scopeKey
        ? held
        : undefined,
    );
    source.forEach((before, index) => {
      if (
        before.reference !== selected &&
        before.reference !== focused &&
        !bulkSelection.includes(before.reference)
      )
        return;
      const listed = tickets.find((ticket) => ticket.id === before.id);
      const after = listed ?? details[before.reference];
      if (
        !next.has(before.id) &&
        ((!listed && allowMissing && previousScope === scopeKey) ||
          (after &&
            (before.status !== after.status ||
              before.plan_id !== after.plan_id ||
              before.project_id !== after.project_id)))
      )
        next.set(before.id, { status: before.status, index, ticket: before });
    });
    setSource(tickets);
    setHeld(next);
  }
  // A picker temporarily owns focus. It is part of the row's interaction,
  // whereas moving to another row or clicking elsewhere ends that interaction.
  useEffect(() => {
    const interact = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const row =
        target.closest<HTMLElement>("[data-ticket-reference]") ??
        target
          .closest(".ticket-rows > li")
          ?.querySelector<HTMLElement>("[data-ticket-reference]");
      if (row) {
        setAllowMissing(true);
        const reference = row.dataset.ticketReference ?? null;
        if (reference !== focused) release();
        setFocused(reference);
      } else if (target.closest(".ticket-detail")) {
        setAllowMissing(true);
      } else if (
        !target.closest(
          '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-slot="popover-content"]',
        ) &&
        !target.closest(".ticket-detail")
      ) {
        setFocused(null);
        if (event.type === "click" || !selected) release();
      }
    };
    document.addEventListener("focusin", interact);
    document.addEventListener("click", interact);
    return () => {
      document.removeEventListener("focusin", interact);
      document.removeEventListener("click", interact);
    };
  });
  const pending = [...held.keys()].join(",");
  useEffect(() => {
    if (!pending) return;
    let timeout = 0;
    let lastInput = Date.now();
    const check = () => {
      window.clearTimeout(timeout);
      const remaining = 3000 - (Date.now() - lastInput);
      if (remaining > 0) timeout = window.setTimeout(check, remaining);
      else if (
        !hovered.current ||
        !pending.split(",").includes(hovered.current)
      )
        release();
    };
    wake.current = check;
    const schedule = () => {
      lastInput = Date.now();
      check();
    };
    schedule();
    document.addEventListener("keydown", schedule);
    document.addEventListener("pointerdown", schedule);
    document.addEventListener("pointermove", schedule);
    return () => {
      window.clearTimeout(timeout);
      wake.current = () => {};
      document.removeEventListener("keydown", schedule);
      document.removeEventListener("pointerdown", schedule);
      document.removeEventListener("pointermove", schedule);
    };
  }, [pending]);
  useEffect(() => {
    if (!arrivals.size) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const clear = () => {
      if (media.matches) setArrivals(new Set());
    };
    // Reduced motion has no animationend; clear the state as well as the CSS.
    const timeout = window.setTimeout(clear, 0);
    media.addEventListener("change", clear);
    return () => {
      window.clearTimeout(timeout);
      media.removeEventListener("change", clear);
    };
  }, [arrivals]);
  const displayed = [...tickets];
  for (const [id, placement] of held) {
    const index = displayed.findIndex((ticket) => ticket.id === id);
    const ticket =
      index < 0
        ? (details[placement.ticket.reference] ?? placement.ticket)
        : displayed.splice(index, 1)[0]!;
    displayed.splice(Math.min(placement.index, displayed.length), 0, ticket);
  }
  return {
    tickets: displayed,
    status: (ticket: Ticket) => held.get(ticket.id)?.status ?? ticket.status,
    arrivals,
    onArrivalEnd: (id: string) =>
      setArrivals(
        (previous) => new Set([...previous].filter((item) => item !== id)),
      ),
    onPointerEnter: (id: string) => {
      hovered.current = id;
    },
    onPointerLeave: () => {
      hovered.current = null;
      wake.current();
    },
  };
}
