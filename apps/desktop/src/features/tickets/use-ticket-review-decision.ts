import { useContext, useRef, useState } from "react";
import { useStatusLine } from "@/components/ui/use-status-line";
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
) & { nextReview: NextReview };

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
  const [draft, setDraft] = useState<TicketUpdateDraft | null>(null);
  const [pending, setPending] = useState(false);
  const moving = useRef(false);
  const canSend = reviewVisible && !blocked && !opening && recoveryReady;
  const canMove =
    reviewVisible && !externalSource(ticket) && !blocked && !opening && !draft;
  if (!active && decision) setDecision(null);
  if ((!active || !reviewVisible) && draft) setDraft(null);

  function openSendBack() {
    if (!canSend || moving.current) return;
    setDraft(
      readTicketUpdateDraft(recovery, id, "send-back") ?? {
        brief: "",
        requestId: null,
      },
    );
  }

  function updateDraft(brief: string) {
    if (moving.current) return;
    const nextDraft = {
      brief,
      requestId: brief.trim() === draft?.brief.trim() ? draft.requestId : null,
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
      requestId: draft.requestId ?? crypto.randomUUID(),
      agent,
    });
  }

  function moveToDone() {
    if (!canMove || moving.current) return;
    void startDecision();
  }

  function startDecision(send?: {
    brief: string;
    requestId: string;
    agent: string;
  }) {
    const request = send?.requestId ?? crypto.randomUUID();
    const undoRequest = crypto.randomUUID();
    let queueRead: Promise<NextReview> | undefined;

    async function decide() {
      if (moving.current) return;
      moving.current = true;
      setPending(true);
      try {
        if (send) {
          const draft = { brief: send.brief, requestId: request };
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
        const updated = send
          ? await client.sendBack(reference, send.brief.trim(), request)
          : await client.changeTicket(
              reference,
              { status: "Done", expected_status: "In review" },
              request,
            );
        if (send) {
          const saved = readTicketUpdateDraft(recovery, id, "send-back");
          if (saved?.requestId === request && saved.brief === send.brief) {
            void keepTicketUpdateDraft(recovery, id, "send-back", null).catch(
              () => {},
            );
            setDraft(null);
          }
        }
        setDecision(
          send
            ? {
                kind: "sent back",
                nextReview,
                brief: send.brief.trim(),
                agent: send.agent,
              }
            : { kind: "done", nextReview },
        );
        line.show({
          message: send
            ? `Sent ${reference} back to In progress`
            : `Moved ${reference} to Done`,
          undo: async () => {
            const restored = send
              ? await client.undoSendBack(reference, request, undoRequest)
              : await client.changeTicket(
                  reference,
                  { status: "In review", expected_status: "Done" },
                  undoRequest,
                );
            setDecision(null);
            await changed(restored);
          },
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
          action: { label: "Retry", run: retryDecision },
        });
      } finally {
        moving.current = false;
        setPending(false);
      }
    }

    function retryDecision() {
      if (!send) return decide();
      const saved = readTicketUpdateDraft(recovery, id, "send-back");
      if (!saved?.brief.trim()) {
        line.show({
          tone: "error",
          message: "Enter what needs to change before sending back.",
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
        requestId: saved.requestId ?? crypto.randomUUID(),
        agent: send.agent,
      });
    }

    return decide();
  }

  return {
    reviewVisible,
    decision,
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
