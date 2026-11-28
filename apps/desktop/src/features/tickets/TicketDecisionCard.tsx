import {
  useContext,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { ArrowRight } from "lucide-react";
import { Kbd } from "@/components/ui/kbd";
import {
  ariaKeyShortcuts,
  matchesShortcut,
  shortcutLabel,
} from "@/lib/shortcuts";
import type { LatestUpdate } from "@/lib/api/progress";
import { client } from "@/lib/api/client";
import { toFailure } from "@/lib/api/bridge-failure";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { editingBlockedReason, useWorkspaceState } from "@/lib/workspace-state";
import { externalSource } from "./ticket-source";
import { TicketReviewProof } from "./TicketReviewProof";
import { TicketReply } from "./TicketReply";
import { TicketSendBackForm } from "./TicketSendBackForm";
import { DraftRecoveryGate } from "@/lib/draft-recovery-context";
import type {
  NextReview,
  TicketReviewDecision,
} from "./use-ticket-review-decision";
import { SourceLink } from "./SourceLink";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Clamp } from "@/components/ui/disclosure";
import { FailureState } from "@/components/ui/failure-alert";
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

export type DecisionFocus = { element: Element | null; moved: boolean };

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
  reviewDecision,
  decisionFocusRef,
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
  reviewDecision: TicketReviewDecision;
  decisionFocusRef: RefObject<DecisionFocus | null>;
}) {
  const { record: ticket, opening } = useOpenTicket();
  const agent = useContext(AgentContext);
  const blocked = editingBlockedReason(useWorkspaceState()) !== null;
  const latestUpdate = useOpenTicket("latestUpdate");
  const update =
    latestUpdate.value === undefined
      ? (ticket.progress_summary ?? null)
      : latestUpdate.value;
  const reviewerAgent = update?.editing_agent ?? "the agent";
  const {
    canMove,
    canSend,
    cancelSendBack,
    decision,
    draft,
    moveToDone,
    openSendBack,
    pending,
    replaceNextReview,
    reviewVisible,
    sendBack,
    updateDraft,
  } = reviewDecision;
  const card = useRef<HTMLElement>(null);
  const sendButton = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const restoreSendFocus = useRef(false);
  const next = useRef<HTMLAnchorElement>(null);
  const queueMessage = useRef<HTMLParagraphElement>(null);
  const reference = ticket.reference;
  const owner = externalSource(ticket);
  const agentState =
    agent?.reference === reference && agent.openedWithCard ? agent.state : null;
  const review = !ticket.trashed && ticket.status === "In review";
  const decided =
    !ticket.trashed &&
    ((ticket.status === "Done" && decision?.kind === "done") ||
      (ticket.status === "In progress" && decision?.kind === "sent back"));
  const writingBack = draft !== null;
  const resultShown = decided && agentState?.kind !== "request";

  function startMove() {
    if (!canMove || pending) return;
    decisionFocusRef.current = {
      element: document.activeElement,
      moved: false,
    };
    moveToDone();
  }

  function startSendBack() {
    if (!canSend || pending || !draft?.brief.trim()) return;
    decisionFocusRef.current = {
      element: document.activeElement,
      moved: false,
    };
    sendBack(reviewerAgent);
  }

  const reviewKey = useEffectEvent((event: KeyboardEvent) => {
    const target = event.target;
    const pane =
      card.current?.closest(".ticket-detail") ??
      card.current?.closest(".detail-content");
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.repeat ||
      !(target instanceof Element) ||
      !pane?.contains(target) ||
      target.closest("[hidden], [inert]") ||
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
      startMove();
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
    if (resultShown) {
      const origin = decisionFocusRef.current;
      const focused = document.activeElement;
      decisionFocusRef.current = null;
      if (
        origin &&
        (focused === origin.element ||
          (!origin.moved &&
            focused === document.body &&
            (!origin.element?.isConnected ||
              origin.element.closest("[hidden], [inert]"))))
      ) {
        (next.current ?? queueMessage.current)?.focus();
      }
    } else if (writingBack) field.current?.focus();
    else if (restoreSendFocus.current) sendButton.current?.focus();
    restoreSendFocus.current = false;
  }, [active, decisionFocusRef, resultShown, writingBack]);

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
  if (resultShown && decision) {
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
        <NextReviewAction
          review={decision.nextReview}
          anchor={next}
          message={queueMessage}
          replaceNextReview={replaceNextReview}
          select={select}
        />
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
          failure={latestUpdate.failure}
          retry={latestUpdate.retry}
          newUpdate={update !== null && isNewUpdate(update, seenTime)}
        />
        {review && <TicketReviewProof onEvidence={onEvidence} />}
        {latest && (
          <DraftRecoveryGate>
            <TicketReply active={active} disabled={opening || blocked} />
          </DraftRecoveryGate>
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
            onSubmit={startSendBack}
            onCancel={() => {
              restoreSendFocus.current = true;
              cancelSendBack();
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
                onClick={startMove}
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

function NextReviewAction({
  review,
  anchor,
  message,
  replaceNextReview,
  select,
}: {
  review: NextReview;
  anchor: RefObject<HTMLAnchorElement | null>;
  message: RefObject<HTMLParagraphElement | null>;
  replaceNextReview: TicketReviewDecision["replaceNextReview"];
  select: (reference: string) => void;
}) {
  const checking = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  const focusMessage = useRef(false);
  useLayoutEffect(() => {
    if (
      review.kind === "empty" &&
      focusMessage.current &&
      document.activeElement === document.body
    )
      message.current?.focus();
    focusMessage.current = false;
  }, [message, review]);

  async function openNext(origin: HTMLElement) {
    const link = anchor.current;
    if (review.kind !== "next" || checking.current || !link) return;
    const { reference } = review;
    const visible = () =>
      link === anchor.current &&
      link.isConnected &&
      !link.closest("[hidden], [inert]");
    if (!visible()) return;
    checking.current = true;
    // Keep focus on the link while clearing the inline Retry button.
    if (origin !== link && document.activeElement === origin) link.focus();
    setBusy(true);
    setFailure(null);
    let action = `check ${reference} for review`;
    try {
      const candidate = await client
        .showTicket(reference)
        .catch((reason: unknown) => {
          if (toFailure(reason).kind !== "not_found") throw reason;
          return null;
        });
      if (!visible()) return;
      if (
        candidate?.reference === reference &&
        candidate.status === "In review" &&
        !candidate.trashed
      ) {
        select(reference);
        return;
      }
      action = "check what else is in review";
      await replaceNextReview(review, () => {
        if (!visible()) return false;
        focusMessage.current = document.activeElement === link;
        return true;
      });
    } catch (reason) {
      if (visible()) setFailure(describeFailure(reason, action));
    } finally {
      checking.current = false;
      setBusy(false);
    }
  }

  if (review.kind !== "next") {
    return (
      <p
        ref={message}
        tabIndex={-1}
        role="status"
        className="ticket-decision-byline ticket-review-focus"
      >
        {review.kind === "unavailable"
          ? "Couldn't check what else is in review"
          : review.staleReference
            ? `${review.staleReference} is no longer in review`
            : "Nothing else in review"}
      </p>
    );
  }
  const { reference } = review;
  return (
    <>
      <div className="ticket-decision-row">
        <Button asChild variant="outline" size="compact" busy={busy}>
          <a
            ref={anchor}
            className="ticket-review-focus"
            href={`ticketd://ticket/${reference}`}
            onClick={(event) => {
              event.preventDefault();
              void openNext(event.currentTarget);
            }}
          >
            Next to review
            <ArrowRight aria-hidden="true" />
          </a>
        </Button>
      </div>
      {failure && (
        <FailureState
          size="inline"
          failure={failure}
          onRetry={(event) => void openNext(event.currentTarget)}
        />
      )}
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
  failure,
  retry,
  newUpdate,
}: {
  review: boolean;
  blockers: ReactNode;
  onAcceptance: (offset: number) => void;
  select: (reference: string) => void;
  update: LatestUpdate | null;
  loading: boolean;
  failure: FailureDescription | null;
  retry: () => void;
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
      {failure && (
        <FailureState size="inline" failure={failure} onRetry={retry} />
      )}
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
            {full.failure && (
              <FailureState
                size="inline"
                failure={{
                  ...full.failure,
                  title: "Couldn't load the full report",
                }}
                onRetry={full.retry}
              />
            )}
          </div>
        </>
      ) : (
        !failure && (
          <p className="ticket-decision-byline">
            {loading
              ? "Loading update…"
              : review
                ? "No report yet"
                : "No update yet"}
          </p>
        )
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
