import { useEffect, useRef, useState } from "react";
import { client, type Ticket } from "@/lib/api/client";
import { failureText } from "@/lib/api/describe-failure";
import type { useTicketBoard } from "./useTicketBoard";
import { ticketStatusChoices } from "./ticket-source";

type Attempt = { ticket: Ticket; status: string; id: string };
type Review = { ticket: Ticket; status: string };
/** Where a card was before it moved at once, so a failure can put it back. */
export type BoardMove = { status: string; index: number };
type Notice = { message: string; undo?: () => unknown };

/**
 * One status action shared by the card menu and pointer moves. Core owns every
 * write; the board shows the move at once (P10): the card leads its new
 * column with "Saving…" while a dashed slot holds its old place, and a
 * failure puts it back with the reason on the card. A confirmed move is said
 * in the pane's status line with Undo.
 */
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
  const [moves, setMoves] = useState<ReadonlyMap<string, BoardMove>>(new Map());
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ scope: string } & Notice>({
    scope: workspace.board.key,
    message: "",
  });
  if (notice.scope !== workspace.board.key)
    setNotice({ scope: workspace.board.key, message: "" });
  const [review, setReview] = useState<Review | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  function clearNotice() {
    setNotice({ scope: latest.current.board.key, message: "" });
  }

  function lock(reference: string, value: boolean) {
    if (value) busy.current.add(reference);
    else busy.current.delete(reference);
    setPending(new Set(busy.current));
  }
  function trackMove(reference: string, move: BoardMove | null) {
    setMoves((old) => {
      const next = new Map(old);
      if (move) next.set(reference, move);
      else next.delete(reference);
      return next;
    });
  }
  /** Shows the move at once; null when the card was not on the board. */
  function moveAtOnce(ticket: Ticket, status: string): BoardMove | null {
    const from = latest.current.board.placeTicket({ ...ticket, status });
    if (from.index < 0) return null;
    trackMove(ticket.reference, from);
    return from;
  }
  /** Puts a card back where it was after a move that did not happen. */
  function putBack(ticket: Ticket, from: BoardMove | null) {
    if (from && ticket.status === from.status)
      latest.current.board.placeTicket(ticket, from.index);
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
        (trigger ?? board)?.focus({ preventScroll: true });
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
  async function saved(reference: string, previous?: string) {
    const current = await reconcile(reference);
    for (;;) {
      const board = latest.current.board;
      const matches = await board.matches(current);
      if (board.key !== latest.current.board.key) continue;
      // Undo is a move back, offered unless either side needs a review.
      const undoable =
        previous !== undefined &&
        previous !== current.status &&
        previous !== "Duplicate" &&
        current.status !== "Duplicate";
      setNotice({
        scope: board.key,
        message: `Moved ${reference} to ${current.status}${matches ? "" : ". It no longer matches the filters"}`,
        ...(undoable && { undo: () => choose(current, previous) }),
      });
      return;
    }
  }
  /** Sends one status change; true once the core has confirmed it. */
  async function submit(attempt: Attempt, from: BoardMove | null) {
    const reference = attempt.ticket.reference;
    lock(reference, true);
    setFailures((old) => ({ ...old, [reference]: "" }));
    clearNotice();
    attempts.current.set(reference, attempt);
    const move = from ?? moveAtOnce(attempt.ticket, attempt.status);
    try {
      await client.changeTicket(
        reference,
        { status: attempt.status },
        attempt.id,
      );
      await saved(reference, attempt.ticket.status);
      attempts.current.delete(reference);
      return true;
    } catch (reason) {
      let placement =
        "Its saved status couldn't be checked. Retry to check again.";
      try {
        const current = await reconcile(reference);
        putBack(current, move);
        placement =
          current.status === attempt.ticket.status
            ? `It is still ${current.status}.`
            : `It is now ${current.status}.`;
      } catch {
        putBack(attempt.ticket, move);
      }
      setFailures((old) => ({
        ...old,
        [reference]: `${failureText(reason, `move ${reference} to ${attempt.status}`)} ${placement}`,
      }));
      return false;
    } finally {
      trackMove(reference, null);
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
      await submit(previous, null);
      return;
    }
    attempts.current.delete(reference);
    returnFocus.current = document.querySelector<HTMLElement>(
      `button[aria-label="Change status of ${reference}"]`,
    );
    lock(reference, true);
    clearNotice();
    setFailures((old) => ({ ...old, [reference]: "" }));
    // A move that needs a review (to or from Duplicate) waits for it.
    const reviewed =
      status === "Duplicate" ||
      (ticket.status === "Duplicate" && Boolean(ticket.duplicate_of));
    let from = reviewed ? null : moveAtOnce(ticket, status);
    try {
      // Authority may have changed since the card was read. The write also validates atomically.
      const current = await client.showTicket(reference);
      latest.current.updateTicket(current);
      if (current.status === status) {
        await saved(reference);
        from = null;
        return;
      }
      if (current.trashed || !ticketStatusChoices(current).includes(status)) {
        putBack(current, from);
        from = null;
        await latest.current.refresh();
        throw new Error(
          "This status is no longer available. Review the current status choices",
        );
      }
      if (
        status === "Duplicate" ||
        (current.status === "Duplicate" && current.duplicate_of)
      ) {
        putBack(current, from);
        from = null;
        setReview({ ticket: current, status });
        return;
      }
      lock(reference, false);
      const move = from;
      from = null;
      await submit({ ticket: current, status, id: crypto.randomUUID() }, move);
    } catch (reason) {
      putBack(ticket, from);
      setFailures((old) => ({
        ...old,
        [reference]: failureText(reason, `change the status of ${reference}`),
      }));
    } finally {
      trackMove(reference, null);
      lock(reference, false);
      restoreFocus(reference);
    }
  }
  return {
    choose,
    pending,
    moves,
    failures,
    notice: notice.scope === workspace.board.key ? notice.message : "",
    noticeUndo: notice.scope === workspace.board.key ? notice.undo : undefined,
    dismissNotice: clearNotice,
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
      void submit({ ticket, status, id: crypto.randomUUID() }, null);
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
      if (attempt) void submit(attempt, null);
      else if (intent) void choose(intent.ticket, intent.status);
    },
    /** Hides a card's failure once read (its × or a later success). */
    dismissFailure(reference: string) {
      setFailures((old) => ({ ...old, [reference]: "" }));
    },
  };
}
