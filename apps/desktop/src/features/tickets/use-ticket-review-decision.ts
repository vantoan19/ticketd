import { useContext, useRef, useState } from "react";
import { useStatusLine } from "@/components/ui/use-status-line";
import { BridgeFailure } from "@/lib/api/bridge-failure";
import { client, type Ticket } from "@/lib/api/client";
import { describeFailure } from "@/lib/api/describe-failure";
import {
  DraftRecoveryReadyContext,
  useDraftRecovery,
} from "@/lib/draft-recovery-context";
import { editingBlockedReason, useWorkspaceState } from "@/lib/workspace-state";
import { useKnownTicket, useOpenTicket } from "./open-ticket";
import { AgentContext } from "./ticket-agent-context";
import { externalSource } from "./ticket-source";
import {
  keepTicketUpdateDraft,
  readTicketUpdateDraft,
  type TicketUpdateDraft,
} from "./ticket-update-draft";

type ReviewQueue = readonly Pick<Ticket, "reference" | "status">[];
export type ReadReviewQueue = (fresh?: boolean) => Promise<ReviewQueue>;

type ReviewSuggestion = {
  kind: "next";
  reference: string;
  successors: string[];
};
export type NextReview =
  | ReviewSuggestion
  | { kind: "empty"; staleReference?: string }
  | { kind: "unavailable" };

type ReviewDecision = (
  { kind: "done" } | { kind: "sent back"; brief: string; agent: string }
) & {
  requestId: string;
  nextReview: NextReview;
  statusHistoryNumber: number | undefined;
};

type SendBackDraft = TicketUpdateDraft & { reviewNumber: number };

function nextReviewFrom(
  references: string[],
  staleReference?: string,
): NextReview {
  const [reference, ...successors] = references;
  if (reference) return { kind: "next", reference, successors };
  return staleReference ? { kind: "empty", staleReference } : { kind: "empty" };
}

async function nextReviewAfter(
  reference: string,
  readReviewQueue: ReadReviewQueue | undefined,
): Promise<NextReview> {
  if (!readReviewQueue) return { kind: "unavailable" };
  try {
    const queue = await readReviewQueue();
    const slot = queue.findIndex((item) => item.reference === reference);
    return nextReviewFrom(
      [...queue.slice(slot + 1), ...queue.slice(0, Math.max(0, slot))]
        .filter(
          (item) => item.reference !== reference && item.status === "In review",
        )
        .map((item) => item.reference),
    );
  } catch {
    return { kind: "unavailable" };
  }
}

/** The ticket page owns the review while its card remounts from peek to full page. */
export function useTicketReviewDecision(
  active: boolean,
  readReviewQueue: ReadReviewQueue | undefined,
) {
  const { record: ticket, opening, changed, retry } = useOpenTicket();
  const knownTicket = useKnownTicket();
  const { id, reference } = ticket;
  const reviewNumber = ticket.status_history_number ?? 0;
  const agent = useContext(AgentContext);
  const agentShowing =
    agent?.reference === reference && agent.openedWithCard && agent.state;
  const reviewVisible =
    !ticket.trashed && ticket.status === "In review" && !agentShowing;
  const line = useStatusLine();
  const blocked = editingBlockedReason(useWorkspaceState()) !== null;
  const recovery = useDraftRecovery();
  const recoveryReady = useContext(DraftRecoveryReadyContext);
  const [decision, setDecision] = useState<ReviewDecision | null>(null);
  const [draft, setDraft] = useState<SendBackDraft | null>(null);
  // The status-line action can outlive the form and a failed draft save.
  const latestDraft = useRef<SendBackDraft | null>(null);
  const [pending, setPending] = useState(false);
  const moving = useRef(false);
  const canSend = reviewVisible && !blocked && !opening && recoveryReady;
  const canMove =
    reviewVisible && !externalSource(ticket) && !blocked && !opening && !draft;
  if (!active && decision) setDecision(null);
  if (
    draft &&
    (!active || !reviewVisible || draft.reviewNumber !== reviewNumber)
  )
    setDraft(null);

  async function replaceNextReview(
    stale: ReviewSuggestion,
    accept: () => boolean,
  ) {
    const queue = await readReviewQueue?.(true);
    if (!queue) throw new Error("Review queue unavailable");
    const eligible = new Set(
      queue
        .filter(
          (item) => item.status === "In review" && item.reference !== reference,
        )
        .map((item) => item.reference),
    );
    // The decision removed its row. Continue from the original position when
    // possible, then consider tickets that entered the queue since the decision.
    const originalOrder = [stale.reference, ...stale.successors].filter(
      (item) => eligible.delete(item),
    );
    const nextReview = nextReviewFrom(
      [...originalOrder, ...eligible],
      stale.reference,
    );
    if (accept()) {
      setDecision((current) =>
        current?.nextReview === stale ? { ...current, nextReview } : current,
      );
    }
  }

  function showDraft(note: SendBackDraft) {
    latestDraft.current = note;
    setDraft(note);
  }

  function openSendBack() {
    if (!canSend || moving.current) return;
    const saved =
      latestDraft.current ?? readTicketUpdateDraft(recovery, id, "send-back");
    showDraft({
      brief: saved?.brief ?? "",
      requestId: saved?.reviewNumber === reviewNumber ? saved.requestId : null,
      reviewNumber,
    });
  }

  function updateDraft(brief: string) {
    if (moving.current) return;
    const nextDraft = {
      brief,
      requestId: brief.trim() === draft?.brief.trim() ? draft.requestId : null,
      reviewNumber,
    };
    showDraft(nextDraft);
    void keepTicketUpdateDraft(
      recovery,
      id,
      "send-back",
      brief ? nextDraft : null,
    ).catch(() => {});
  }

  function sendBack(agent: string) {
    if (!canSend || moving.current || !draft?.brief.trim()) return;
    void startDecision({
      brief: draft.brief,
      requestId: draft.requestId,
      agent,
    });
  }

  function moveToDone() {
    if (!canMove || moving.current) return;
    void startDecision();
  }

  function startDecision(originalSend?: {
    brief: string;
    requestId: string | null;
    agent: string;
  }) {
    const request = originalSend?.requestId ?? crypto.randomUUID();
    const undoRequest = crypto.randomUUID();
    let queueRead: Promise<NextReview> | undefined;
    let submitted = Boolean(originalSend?.requestId);

    async function decide(send = originalSend) {
      if (moving.current) return;
      moving.current = true;
      setPending(true);
      let retainingNote = Boolean(send);
      try {
        if (send) {
          const submission = {
            brief: send.brief,
            requestId: request,
            reviewNumber,
          };
          latestDraft.current = submission;
          setDraft((current) =>
            current?.reviewNumber === reviewNumber &&
            current.brief === send.brief
              ? submission
              : current,
          );
          // Retain the exact request before sending so a lost reply can be replayed.
          await recovery.flush();
          await keepTicketUpdateDraft(recovery, id, "send-back", submission);
          retainingNote = false;
        }
        // Keep the queue through a retry: the first write may have succeeded and removed its row.
        queueRead ??= nextReviewAfter(reference, readReviewQueue);
        const nextReview = await queueRead;
        if (nextReview.kind === "unavailable") queueRead = undefined;
        const mayReplay = submitted;
        submitted = true;
        let updated = send
          ? await client.sendBack(
              reference,
              send.brief.trim(),
              request,
              reviewNumber,
            )
          : await client.changeTicket(
              reference,
              {
                status: "Done",
                expected_status: "In review",
                expected_status_history_number: reviewNumber,
              },
              request,
            );
        if (mayReplay) {
          // An identical retry can return an earlier receipt after the ticket
          // moves on. Confirm that receipt before showing it as the outcome.
          const current = await client.showTicket(reference);
          if (
            current.trashed ||
            current.id !== updated.id ||
            current.status !== updated.status ||
            current.status_history_number !== updated.status_history_number
          )
            throw new BridgeFailure("conflict", "The ticket has moved on.");
          updated = current;
        }
        if (send) {
          const saved = readTicketUpdateDraft(recovery, id, "send-back");
          if (
            saved?.requestId === request &&
            saved.reviewNumber === reviewNumber &&
            saved.brief === send.brief
          ) {
            void keepTicketUpdateDraft(recovery, id, "send-back", null).catch(
              () => {},
            );
            latestDraft.current = null;
            setDraft(null);
          }
        }
        const completionNumber = updated.status_history_number;
        const receipt = {
          requestId: request,
          nextReview,
          statusHistoryNumber: completionNumber,
        };
        setDecision(
          send
            ? {
                kind: "sent back",
                brief: send.brief.trim(),
                agent: send.agent,
                ...receipt,
              }
            : { kind: "done", ...receipt },
        );
        const undo = send
          ? () => client.undoSendBack(reference, request, undoRequest)
          : completionNumber === undefined
            ? undefined
            : () =>
                client.changeTicket(
                  reference,
                  {
                    status: "In review",
                    expected_status: "Done",
                    expected_status_history_number: completionNumber,
                  },
                  undoRequest,
                );
        line.show({
          message: send
            ? `Sent ${reference} back to In progress`
            : `Moved ${reference} to Done`,
          ...(undo && {
            undo: async () => {
              const restored = await undo();
              setDecision((current) =>
                current?.requestId === request ? null : current,
              );
              // The restored review can already have been decided again while
              // this reply was in flight. Refresh without refilling its old copy.
              const current = knownTicket(reference);
              const movedOn =
                current === null ||
                (current?.status_history_number ?? 0) >
                  (restored.status_history_number ?? 0);
              await changed(movedOn ? undefined : restored);
            },
          }),
        });
        await changed(updated);
      } catch (reason) {
        const failure = describeFailure(
          reason,
          retainingNote
            ? "save the Send back note"
            : send
              ? `send ${reference} back`
              : `move ${reference} to Done`,
        );
        if (failure.code === "conflict") await retry();
        line.show({
          tone: "error",
          message: retainingNote
            ? `${failure.title}. The note is still available in Send back.`
            : `${failure.title}. ${failure.sentence}`,
          details: failure.details,
          ...(failure.action === "retry" && {
            action: { label: "Retry", run: retryDecision },
          }),
        });
      } finally {
        moving.current = false;
        setPending(false);
      }
    }

    function retryDecision() {
      if (!originalSend) return decide();
      const current = latestDraft.current;
      if (current?.reviewNumber !== reviewNumber || !current.brief.trim()) {
        line.show({
          tone: "error",
          message: "Open Send back to review the saved note before sending.",
        });
        return;
      }
      if (
        current.requestId === request &&
        current.brief.trim() === originalSend.brief.trim()
      )
        return decide({ ...originalSend, brief: current.brief });
      return startDecision({
        brief: current.brief,
        requestId: current.requestId,
        agent: originalSend.agent,
      });
    }

    return decide();
  }

  return {
    reviewVisible,
    decision:
      decision?.statusHistoryNumber === ticket.status_history_number
        ? decision
        : null,
    draft,
    pending,
    canMove,
    canSend,
    openSendBack,
    updateDraft,
    sendBack,
    moveToDone,
    replaceNextReview,
    cancelSendBack: () => setDraft(null),
  };
}

export type TicketReviewDecision = ReturnType<typeof useTicketReviewDecision>;
