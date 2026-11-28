import {
  useContext,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowRight } from "lucide-react";
import { Kbd } from "@/components/ui/kbd";
import { useStatusLine } from "@/components/ui/use-status-line";
import {
  ariaKeyShortcuts,
  matchesShortcut,
  shortcutLabel,
} from "@/lib/shortcuts";
import { client, type Ticket } from "@/lib/api/client";
import type { LatestUpdate } from "@/lib/api/progress";
import { describeFailure } from "@/lib/api/describe-failure";
import { editingBlockedReason, useWorkspaceState } from "@/lib/workspace-state";
import { externalSource } from "./ticket-source";
import { TicketReviewProof } from "./TicketReviewProof";
import { TicketReply } from "./TicketReply";
import { TicketSendBackForm } from "./TicketSendBackForm";
import {
  DraftRecoveryReadyContext,
  useDraftRecovery,
} from "@/lib/draft-recovery-context";
import {
  keepSendBackDraft,
  readSendBackDraft,
  type SendBackDraft,
} from "./send-back-draft";
import { SourceLink } from "./SourceLink";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Clamp } from "@/components/ui/disclosure";
import { Time } from "@/components/ui/time";
import { HarnessMark } from "@/features/chats/HarnessMark";
import { useEditingHarness } from "@/features/chats/editing-harness";
import { MarkdownDocument } from "@/features/markdown/MarkdownDocument";
import { acceptanceSection } from "./acceptance-section";
import { withoutBom } from "./mention-passage";
import { useOpenTicket } from "./open-ticket";
import { AgentContext } from "./ticket-agent-context";
import { TicketAgentCard } from "./TicketAgentCard";
import { agentCardName } from "./ticket-agent-state";
import { DecisionCardContent } from "./decision-card-motion";
import { NewUpdateDot } from "./NewUpdateDot";
import { isNewUpdate } from "./ticket-seen-time";
import "./ticket-decision-card.css";

export type ReviewQueue = readonly Pick<Ticket, "reference" | "status">[];

type ReviewDecision = (
  { kind: "done" } | { kind: "sent back"; brief: string; agent: string }
) & { next: string | undefined };

export function TicketDecisionCard({
  active,
  seenTime,
  onAcceptance,
  onEvidence,
  onOpenUpdate,
  onRepresentedUpdate,
  blockerCount,
  blockers,
  doneFallback,
  select,
  readReviewQueue,
}: {
  active: boolean;
  seenTime: number | null;
  onAcceptance: (offset: number) => void;
  onEvidence: () => void;
  onOpenUpdate: (id: string) => void;
  onRepresentedUpdate: (update: LatestUpdate | null) => void;
  blockerCount: number;
  blockers: ReactNode;
  doneFallback?: ReactNode;
  select: (reference: string) => void;
  readReviewQueue?: (() => Promise<ReviewQueue>) | undefined;
}) {
  const { record: ticket, opening, changed, retry } = useOpenTicket();
  const agent = useContext(AgentContext);
  const line = useStatusLine();
  const blocked = editingBlockedReason(useWorkspaceState()) !== null;
  const recovery = useDraftRecovery();
  const recoveryReady = useContext(DraftRecoveryReadyContext);
  const latestUpdate = useOpenTicket("latestUpdate");
  const update =
    latestUpdate.value === undefined
      ? (ticket.progress_summary ?? null)
      : latestUpdate.value;
  const reviewerAgent = update?.editing_agent ?? "the agent";
  const [decision, setDecision] = useState<ReviewDecision | null>(null);
  const [draft, setDraft] = useState<SendBackDraft | null>(null);
  const [pending, setPending] = useState(false);
  const moving = useRef(false);
  const card = useRef<HTMLElement>(null);
  const sendButton = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const restoreSendFocus = useRef(false);
  const next = useRef<HTMLAnchorElement>(null);
  const nothing = useRef<HTMLParagraphElement>(null);
  const reference = ticket.reference;
  const owner = externalSource(ticket);
  const agentState =
    agent?.reference === reference && agent.openedWithCard ? agent.state : null;
  const review = !ticket.trashed && ticket.status === "In review";
  const decided =
    !ticket.trashed &&
    ((ticket.status === "Done" && decision?.kind === "done") ||
      (ticket.status === "In progress" && decision?.kind === "sent back"));
  const nextReference = decision?.next;
  const writingBack = draft !== null;
  const reviewVisible = review && !agentState;
  const canSend = reviewVisible && !blocked && !opening && recoveryReady;
  const canMove =
    reviewVisible && !owner && !blocked && !opening && !writingBack;
  if (!active && decision) setDecision(null);
  if ((!active || !reviewVisible) && writingBack) setDraft(null);

  function openSendBack() {
    if (!canSend || moving.current) return;
    setDraft(
      readSendBackDraft(recovery, ticket.id) ?? { brief: "", requestId: null },
    );
  }

  function updateDraft(brief: string) {
    const nextDraft = {
      brief,
      requestId: brief.trim() === draft?.brief.trim() ? draft.requestId : null,
    };
    setDraft(nextDraft);
    void keepSendBackDraft(recovery, ticket.id, brief ? nextDraft : null).catch(
      () => {},
    );
  }

  function sendBack() {
    if (!canSend || moving.current || !draft?.brief.trim()) return;
    const intent = {
      brief: draft.brief,
      requestId: draft.requestId ?? crypto.randomUUID(),
    };
    setDraft(intent);
    startDecision(intent);
  }

  function moveToDone() {
    if (!canMove || moving.current) return;
    startDecision();
  }

  function startDecision(send?: { brief: string; requestId: string }) {
    const request = send?.requestId ?? crypto.randomUUID();
    const undoRequest = crypto.randomUUID();
    let next: Promise<string | undefined> | undefined;
    async function decide() {
      if (moving.current) return;
      moving.current = true;
      setPending(true);
      try {
        if (send) {
          // A lost reply can be retried from the same saved draft with the same ID.
          const saved = readSendBackDraft(recovery, ticket.id);
          if (!saved || saved.brief === send.brief) {
            await recovery.flush();
            await keepSendBackDraft(recovery, ticket.id, send);
          }
        }
        // Keep this queue through a retry, since the write may have landed
        // before its reply was lost and removed the ticket from the results.
        next ??= readReviewQueue?.()
          .then((queue) => {
            const slot = queue.findIndex(
              (item) => item.reference === reference,
            );
            return [
              ...queue.slice(slot + 1),
              ...queue.slice(0, Math.max(0, slot)),
            ].find(
              (item) =>
                item.reference !== reference && item.status === "In review",
            )?.reference;
          })
          .catch(() => {
            next = undefined;
            return undefined;
          });
        const nextReference = await next;
        const updated = send
          ? await client.sendBack(reference, send.brief.trim(), request)
          : await client.changeTicket(
              reference,
              { status: "Done", expected_status: "In review" },
              request,
            );
        if (send) {
          if (readSendBackDraft(recovery, ticket.id)?.requestId === request)
            void keepSendBackDraft(recovery, ticket.id, null).catch(() => {});
          setDraft(null);
        }
        setDecision(
          send
            ? {
                kind: "sent back",
                next: nextReference,
                brief: send.brief.trim(),
                agent: reviewerAgent,
              }
            : { kind: "done", next: nextReference },
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
          action: { label: "Retry", run: decide },
        });
      } finally {
        moving.current = false;
        setPending(false);
      }
    }
    void decide();
  }

  const reviewKey = useEffectEvent((event: KeyboardEvent) => {
    const target = event.target;
    const pane = card.current?.closest(".ticket-detail, .detail-content");
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.repeat ||
      !(target instanceof Element) ||
      !pane?.contains(target) ||
      pane.closest("[hidden], [inert]") ||
      target.closest(
        "input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=textbox]",
      ) ||
      document.querySelector(
        "[role=dialog], [role=alertdialog], [role=menu], [role=listbox], [data-slot=popover-content]",
      )
    )
      return;
    if (canMove && matchesShortcut(event, "ticket-review-done")) {
      event.preventDefault();
      moveToDone();
    } else if (
      canSend &&
      !writingBack &&
      matchesShortcut(event, "ticket-review-send-back")
    ) {
      event.preventDefault();
      openSendBack();
    }
  });
  useEffect(() => {
    if (!active || !reviewVisible) return;
    const press = (event: KeyboardEvent) => reviewKey(event);
    window.addEventListener("keydown", press);
    return () => window.removeEventListener("keydown", press);
  }, [active, reviewVisible]);
  useLayoutEffect(() => {
    if (!active) return;
    if (decided) (next.current ?? nothing.current)?.focus();
    else if (writingBack) field.current?.focus();
    else if (restoreSendFocus.current) sendButton.current?.focus();
    restoreSendFocus.current = false;
  }, [active, decided, writingBack]);

  const latest =
    !ticket.trashed &&
    ticket.status === "In progress" &&
    (agent?.reference !== reference || agent.ready);
  let panel: ReactNode = null;
  const representedUpdate =
    !decided && !agentState && (review || latest) ? update : null;
  useLayoutEffect(() => {
    onRepresentedUpdate(representedUpdate);
  }, [onRepresentedUpdate, representedUpdate]);
  if (decided && decision) {
    panel = (
      <DecisionPanel state={decision.kind === "done" ? "Done" : "Sent back"}>
        <p className="ticket-decision-title">
          {decision.kind === "done"
            ? "Done · just now · by you"
            : `Sent back · waiting for ${decision.agent}`}
        </p>
        {decision.kind === "sent back" && (
          <blockquote className="ticket-decision-report whitespace-pre-wrap">
            {decision.brief}
          </blockquote>
        )}
        {nextReference ? (
          <div className="ticket-decision-row">
            <Button asChild variant="outline" size="compact">
              <a
                ref={next}
                href={`ticketd://ticket/${nextReference}`}
                onClick={(event) => {
                  event.preventDefault();
                  select(nextReference);
                }}
              >
                Next to review
                <ArrowRight aria-hidden="true" />
              </a>
            </Button>
          </div>
        ) : (
          <p ref={nothing} tabIndex={-1} className="ticket-decision-byline">
            Nothing else in review
          </p>
        )}
      </DecisionPanel>
    );
  } else if (agentState) {
    panel = (
      <DecisionPanel
        state={agentCardName(agentState)}
        stateKey={agentState.kind}
        cardRef={card}
      >
        <TicketAgentCard
          state={agentState}
          reference={reference}
          active={active}
          report={review ? (agent?.update ?? null) : null}
          onOpenUpdate={onOpenUpdate}
        />
      </DecisionPanel>
    );
  } else if (review || latest) {
    panel = (
      <DecisionPanel
        state={review ? "Ready for review" : "Latest update"}
        cardRef={card}
      >
        <TicketReport
          review={review}
          onAcceptance={onAcceptance}
          select={select}
          blockers={blockers}
          update={update}
          loading={latestUpdate.value === undefined && !latestUpdate.failure}
          newUpdate={update !== null && isNewUpdate(update, seenTime)}
        />
        {review && <TicketReviewProof onEvidence={onEvidence} />}
        {latest && (
          <TicketReply active={active} disabled={opening || blocked} />
        )}
        {review && draft && (
          <TicketSendBackForm
            field={field}
            brief={draft.brief}
            agent={reviewerAgent}
            sourceName={owner?.provider_name}
            pending={pending}
            disabled={!canSend}
            onChange={updateDraft}
            onSubmit={sendBack}
            onCancel={() => {
              restoreSendFocus.current = true;
              setDraft(null);
            }}
          />
        )}
        {review && !draft && (
          <div className="ticket-decision-row">
            {owner ? (
              <Button asChild variant="outline" size="compact">
                <SourceLink url={owner.url}>
                  Open on {owner.provider_name}
                </SourceLink>
              </Button>
            ) : (
              <Button
                type="button"
                size="compact"
                variant={blockerCount ? "outline" : "default"}
                disabled={!canMove}
                busy={pending}
                onClick={moveToDone}
                aria-keyshortcuts={ariaKeyShortcuts("ticket-review-done")}
              >
                Move to Done
                <Kbd aria-hidden="true">
                  {shortcutLabel("ticket-review-done")}
                </Kbd>
              </Button>
            )}
            <Button
              ref={sendButton}
              type="button"
              variant="outline"
              size="compact"
              disabled={!canSend || pending}
              onClick={openSendBack}
              aria-keyshortcuts={ariaKeyShortcuts("ticket-review-send-back")}
            >
              Send back
              <Kbd aria-hidden="true">
                {shortcutLabel("ticket-review-send-back")}
              </Kbd>
            </Button>
          </div>
        )}
      </DecisionPanel>
    );
  }
  return (
    <>
      {ticket.status === "Done" && !decided && !ticket.trashed && doneFallback}
      {panel}
    </>
  );
}

export function DecisionPanel({
  state,
  stateKey = state,
  cardRef,
  children,
}: {
  state: string;
  stateKey?: string;
  cardRef?: React.Ref<HTMLElement>;
  children: ReactNode;
}) {
  return (
    <Card asChild variant="well">
      <section
        className="ticket-decision-card"
        ref={cardRef}
        aria-label={state}
      >
        <DecisionCardContent state={stateKey}>{children}</DecisionCardContent>
      </section>
    </Card>
  );
}

function TicketReport({
  blockers,
  review,
  onAcceptance,
  select,
  update,
  loading,
  newUpdate,
}: {
  review: boolean;
  blockers: ReactNode;
  onAcceptance: (offset: number) => void;
  select: (reference: string) => void;
  update: LatestUpdate | null;
  loading: boolean;
  newUpdate: boolean;
}) {
  const { record: ticket } = useOpenTicket();
  const full = useOpenTicket(
    "activityNote",
    update?.brief.truncated ? update.activity_id : undefined,
  );
  const editingHarness = useEditingHarness();
  const name = update?.editing_agent ?? "You";
  const acceptance = useMemo(
    () => (review ? acceptanceSection(withoutBom(ticket.body)) : null),
    [review, ticket.body],
  );
  const state = review ? "Ready for review" : "Latest update";
  return (
    <>
      <h3 className="ticket-decision-title">{state}</h3>
      {update ? (
        <>
          <div className="ticket-decision-byline">
            <HarnessMark
              harness={editingHarness(name)}
              name={name}
              decorative
            />
            <strong>{name}</strong>
            <span aria-hidden="true">·</span>
            <Time value={update.reported_at} />
            {newUpdate && <NewUpdateDot />}
          </div>
          <div className="ticket-decision-report">
            <Clamp key={update.activity_id} lines={4}>
              <MarkdownDocument
                source={full.value?.brief ?? update.brief.text}
                select={select}
              />
            </Clamp>
          </div>
        </>
      ) : (
        <p className="ticket-decision-byline">
          {loading
            ? "Loading update…"
            : review
              ? "No report yet"
              : "No update yet"}
        </p>
      )}
      {review && ((acceptance?.total ?? 0) > 0 || blockers) && (
        <div className="ticket-decision-row">
          {acceptance && acceptance.total > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="compact"
              onClick={() => onAcceptance(acceptance.start)}
            >
              Acceptance {acceptance.done} of {acceptance.total}
            </Button>
          )}
          {acceptance && acceptance.total > 0 && blockers && (
            <span aria-hidden="true">·</span>
          )}
          {blockers}
        </div>
      )}
    </>
  );
}
