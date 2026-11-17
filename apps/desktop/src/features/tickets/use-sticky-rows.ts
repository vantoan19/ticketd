import { useEffect, useRef, useState } from "react";
import type { Ticket } from "@/lib/api/client";

type Placement = { status: string; index: number; ticket: Ticket };

const time = (ticket: Ticket) => {
  const at = ticket.updated_at ? Date.parse(ticket.updated_at) : NaN;
  return Number.isNaN(at) ? 0 : at;
};

/**
 * Keep the ledger's reading position while the saved properties update. A row
 * the list dropped shows the newest copy of its Ticket known (`known`, which
 * peeks at the Ticket reads: the open Ticket's page, or the Ticket a write
 * returned), when it is strictly newer than the list's copy (compared as
 * times), and otherwise the list's copy. On a tie the list's copy wins: tags
 * and availability do not move `updated_at`, and a cached copy of a Ticket
 * nobody views may never have been read again. The summary of its latest update, which only the
 * list carries, stays while it still names the Ticket's latest update.
 *
 * `watching` is the open Ticket when its row is held and dropped: the one
 * reference whose changes the list has to follow to keep that row current.
 */
export function useStickyRows(
  tickets: Ticket[],
  selected: string | null,
  known: (reference: string) => Ticket | null | undefined,
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
  const newest = (listed: Ticket): Ticket => {
    const copy = known(listed.reference);
    if (!copy || time(copy) <= time(listed)) return listed;
    return listed.progress_summary !== undefined &&
      listed.progress_summary?.activity_id === copy.latest_update?.activity_id
      ? { ...copy, progress_summary: listed.progress_summary }
      : copy;
  };
  const wake = useRef<() => void>(() => {});
  const hovered = useRef<string | null>(null);
  const [hoveredRow, setHoveredRow] = useState<string | null>(null);
  const interacting = useRef(new Set<string>());
  useEffect(() => {
    interacting.current = new Set(
      [selected, focused, ...bulkSelection].filter(
        (reference): reference is string => reference !== null,
      ),
    );
  }, [selected, focused, bulkSelection]);
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
    if (held.size && selected !== null) {
      setArrivals(new Set(held.keys()));
      setHeld(new Map());
    }
  }
  if (source !== tickets) {
    const next = new Map(
      (previousSelected === selected || selected === null) &&
        previousScope === scopeKey
        ? held
        : undefined,
    );
    source.forEach((before, index) => {
      if (
        before.reference !== selected &&
        before.reference !== focused &&
        before.id !== hoveredRow &&
        !bulkSelection.includes(before.reference)
      )
        return;
      const listed = tickets.find((ticket) => ticket.id === before.id);
      const after = listed ?? newest(before);
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
      // Disabled or unmounted controls can send focus to body without the
      // person leaving the interaction. Only an actual destination releases it.
      if (
        !(target instanceof Element) ||
        (event.type === "focusin" &&
          (target === document.body || target === document.documentElement))
      )
        return;
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
      } else if (
        target.closest(".bulk-controls") &&
        !target.closest('[aria-label="Clear selection"]')
      ) {
        // The bulk bar and its pickers still act on the held selection.
        setAllowMissing(true);
      } else if (target.closest(".ticket-detail")) {
        setAllowMissing(true);
      } else if (
        !target.closest(
          '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-slot="popover-content"]',
        ) &&
        !target.closest(".ticket-detail")
      ) {
        setFocused(null);
        release();
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
      else {
        setHeld((previous) => {
          const next = new Map(previous);
          const released = new Set<string>();
          for (const [id, placement] of previous) {
            if (
              id === hovered.current ||
              interacting.current.has(placement.ticket.reference)
            )
              continue;
            next.delete(id);
            released.add(id);
          }
          if (!released.size) return previous;
          setArrivals(released);
          return next;
        });
      }
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
      index < 0 ? newest(placement.ticket) : displayed.splice(index, 1)[0]!;
    displayed.splice(Math.min(placement.index, displayed.length), 0, ticket);
  }
  const watching =
    selected !== null &&
    [...held].some(
      ([id, placement]) =>
        placement.ticket.reference === selected &&
        !tickets.some((ticket) => ticket.id === id),
    )
      ? selected
      : null;
  return {
    tickets: displayed,
    watching,
    status: (ticket: Ticket) => held.get(ticket.id)?.status ?? ticket.status,
    arrivals,
    onArrivalEnd: (id: string) =>
      setArrivals(
        (previous) => new Set([...previous].filter((item) => item !== id)),
      ),
    onPointerEnter: (id: string) => {
      hovered.current = id;
      setHoveredRow(id);
    },
    onPointerLeave: () => {
      hovered.current = null;
      setHoveredRow(null);
      wake.current();
    },
  };
}
