import { useEffect, useRef, useState } from "react";
import { client, type Ticket } from "@/lib/api/client";
import { toFailure } from "@/lib/api/bridge-failure";
import type { useTicketBoard } from "./useTicketBoard";
import { ticketStatusChoices } from "./ticket-source";

type Attempt = { ticket: Ticket; status: string; id: string };
type Review = { ticket: Ticket; status: string };

/** One status action shared by the card menu and pointer moves. Core owns every write. */
export function useBoardStatus(workspace: {
  board: ReturnType<typeof useTicketBoard>;
  refresh: () => Promise<void>;
  updateTicket: (ticket: Ticket) => void;
}) {
  const latest = useRef(workspace);
  useEffect(() => {
    latest.current = workspace;
  });
  const busy = useRef(new Set<string>());
  const attempts = useRef(new Map<string, Attempt>());
  const intents = useRef(new Map<string, Review>());
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  function lock(reference: string, value: boolean) {
    if (value) busy.current.add(reference);
    else busy.current.delete(reference);
    setPending(new Set(busy.current));
  }
  function restoreFocus(reference: string) {
    requestAnimationFrame(() => {
      const board = document.querySelector<HTMLElement>(
        '[aria-label="Ticket status board"]',
      );
      const trigger = board?.querySelector<HTMLElement>(
        `[aria-label="Change status of ${reference}"]`,
      );
      const active = document.activeElement;
      if (
        active === document.body ||
        active === returnFocus.current ||
        !active?.isConnected
      )
        (trigger ?? board)?.focus();
    });
  }
  async function reconcile(reference: string) {
    // Successful request replays contain historical results, so only a new read is current.
    const current = await client.showTicket(reference);
    latest.current.updateTicket(current);
    latest.current.board.confirmTicket(current);
    await latest.current.refresh();
    return current;
  }
  async function saved(reference: string) {
    const current = await reconcile(reference);
    for (;;) {
      const board = latest.current.board;
      const matches = await board.matches(current);
      if (board.key !== latest.current.board.key) continue;
      setNotice(
        `${reference} is now ${current.status}.${matches ? "" : " It no longer matches the current filters."}`,
      );
      return;
    }
  }
  async function submit(attempt: Attempt) {
    const reference = attempt.ticket.reference;
    lock(reference, true);
    setFailures((old) => ({ ...old, [reference]: "" }));
    setNotice("");
    attempts.current.set(reference, attempt);
    try {
      await client.bulkStatus([reference], attempt.status, attempt.id);
      await saved(reference);
      attempts.current.delete(reference);
    } catch (reason) {
      let placement =
        "Saved status could not be checked. Retry to reconcile this request.";
      try {
        const current = await reconcile(reference);
        placement = `Current saved status: ${current.status}.`;
      } catch {
        /* The last confirmed placement remains visible until a read succeeds. */
      }
      setFailures((old) => ({
        ...old,
        [reference]: `Could not confirm ${reference}'s status change: ${toFailure(reason).message}. ${placement}`,
      }));
    } finally {
      lock(reference, false);
      restoreFocus(reference);
    }
  }
  async function choose(ticket: Ticket, status: string) {
    const reference = ticket.reference;
    if (
      busy.current.has(reference) ||
      review?.ticket.reference === reference ||
      status === ticket.status
    )
      return;
    intents.current.set(reference, { ticket, status });
    const previous = attempts.current.get(reference);
    if (previous?.status === status) {
      await submit(previous);
      return;
    }
    attempts.current.delete(reference);
    returnFocus.current = document.querySelector<HTMLElement>(
      `button[aria-label="Change status of ${reference}"]`,
    );
    lock(reference, true);
    setNotice("");
    setFailures((old) => ({ ...old, [reference]: "" }));
    try {
      // Authority may have changed since the card was read. The write also validates atomically.
      const current = await client.showTicket(reference);
      latest.current.updateTicket(current);
      if (current.status === status) {
        await saved(reference);
        return;
      }
      if (current.trashed || !ticketStatusChoices(current).includes(status)) {
        await latest.current.refresh();
        throw new Error(
          "This status is no longer available. Review the current status choices",
        );
      }
      if (
        status === "Duplicate" ||
        (current.status === "Duplicate" && current.duplicate_of)
      ) {
        setReview({ ticket: current, status });
        return;
      }
      await submit({ ticket: current, status, id: crypto.randomUUID() });
    } catch (reason) {
      setFailures((old) => ({
        ...old,
        [reference]: `Could not change ${reference}: ${toFailure(reason).message}. Try again.`,
      }));
    } finally {
      lock(reference, false);
      restoreFocus(reference);
    }
  }
  return {
    choose,
    pending,
    failures,
    notice,
    review,
    returnFocus,
    cancelReview() {
      const reference = review?.ticket.reference;
      setReview(null);
      if (reference) restoreFocus(reference);
    },
    confirmLeave(status: string) {
      if (!review) return;
      const ticket = review.ticket;
      setReview(null);
      void submit({ ticket, status, id: crypto.randomUUID() });
    },
    completeDuplicate: () =>
      review ? saved(review.ticket.reference) : Promise.resolve(),
    reconcileDuplicate: async () => {
      if (review) await reconcile(review.ticket.reference);
    },
    retry(reference: string) {
      if (busy.current.has(reference)) return;
      const attempt = attempts.current.get(reference);
      const intent = intents.current.get(reference);
      if (attempt) void submit(attempt);
      else if (intent) void choose(intent.ticket, intent.status);
    },
  };
}
