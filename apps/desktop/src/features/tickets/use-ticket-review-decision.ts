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
import { useOpenTicket } from "./open-ticket";
import { AgentContext } from "./ticket-agent-context";
import { externalSource } from "./ticket-source";
import {
  keepTicketUpdateDraft,
  readTicketUpdateDraft,
  type TicketUpdateDraft,
} from "./ticket-update-draft";

export type ReviewQueue = readonly Pick<Ticket, "reference" | "status">[];
type ReadReviewQueue = () => Promise<ReviewQueue>;

type NextReview =
  { kind: "next"; reference: string } | { kind: "empty" | "unavailable" };

type ReviewDecision = (
  { kind: "done" } | { kind: "sent back"; brief: string; agent: string }
) & { nextReview: NextReview; statusHistoryNumber: number | undefined };

type SendBackDraft = TicketUpdateDraft & { reviewNumber: number };

async function nextReviewAfter(
  reference: string,
  readReviewQueue: ReadReviewQueue | undefined,
): Promise<NextReview> {
  if (!readReviewQueue) return { kind: "unavailable" };
  try {
    const queue = await readReviewQueue();
    const slot = queue.findIndex((item) => item.reference === reference);
    const next = [
      ...queue.slice(slot + 1),
      ...queue.slice(0, Math.max(0, slot)),
    ].find(
      (item) => item.reference !== reference && item.status === "In review",
    );
    return next
      ? { kind: "next", reference: next.reference }
      : { kind: "empty" };
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

  function openSendBack() {
    if (!canSend || moving.current) return;
    const saved = readTicketUpdateDraft(recovery, id, "send-back");
    setDraft({
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
    setDraft(nextDraft);
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

  function startDecision(send?: {
    brief: string;
    requestId: string | null;
    agent: string;
  }) {
    const request = send?.requestId ?? crypto.randomUUID();
    const undoRequest = crypto.randomUUID();
    let queueRead: Promise<NextReview> | undefined;
    let submitted = Boolean(send?.requestId);

    async function decide() {
      if (moving.current) return;
      moving.current = true;
      setPending(true);
      try {
        if (send) {
          const draft = { brief: send.brief, requestId: request, reviewNumber };
          setDraft((current) =>
            current?.brief === send.brief ? draft : current,
          );
          // A lost reply can be retried from the same saved draft with the same ID.
          await recovery.flush();
          const saved = readTicketUpdateDraft(recovery, id, "send-back");
          if (!saved || saved.brief === send.brief)
            await keepTicketUpdateDraft(recovery, id, "send-back", draft);
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
            setDraft(null);
          }
        }
        const completionNumber = updated.status_history_number;
        const receipt = { nextReview, statusHistoryNumber: completionNumber };
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
              setDecision(null);
              await changed(restored);
            },
          }),
        });
        await changed(updated);
      } catch (reason) {
        const failure = describeFailure(
          reason,
          send ? `send ${reference} back` : `move ${reference} to Done`,
        );
        if (failure.code === "conflict") await retry();
        line.show({
          tone: "error",
          message: `${failure.title}. ${failure.sentence}`,
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
      if (!send) return decide();
      const saved = readTicketUpdateDraft(recovery, id, "send-back");
      if (saved?.reviewNumber !== reviewNumber || !saved.brief.trim()) {
        line.show({
          tone: "error",
          message: "Open Send back to review the saved note before sending.",
        });
        return;
      }
      if (
        saved.brief === send.brief &&
        (!saved.requestId || saved.requestId === request)
      )
        return decide();
      return startDecision({
        brief: saved.brief,
        requestId: saved.requestId,
        agent: send.agent,
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
    cancelSendBack: () => setDraft(null),
  };
}

export type TicketReviewDecision = ReturnType<typeof useTicketReviewDecision>;
