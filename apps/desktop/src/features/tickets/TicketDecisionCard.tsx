import { useContext, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { Kbd } from "@/components/ui/kbd";
import { useStatusLine } from "@/components/ui/use-status-line";
import { ariaKeyShortcuts, matchesShortcut, shortcutLabel } from "@/lib/shortcuts";
import { client, type Ticket } from "@/lib/api/client";
import { describeFailure } from "@/lib/api/describe-failure";
import { editingBlockedReason, useWorkspaceState } from "@/lib/workspace-state";
import { externalSource } from "./ticket-source";
import { TicketReply } from "./TicketReply";
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
import "./ticket-decision-card.css";

export type ReviewQueue = readonly Pick<Ticket, "reference" | "status">[];

export function TicketDecisionCard({
  active,
  onAcceptance,
  select,
  reviewQueue,
}: {
  active: boolean;
  onAcceptance: (offset: number) => void;
  select: (reference: string) => void;
  reviewQueue: ReviewQueue;
}) {
  const { record: ticket, opening, changed, retry } = useOpenTicket();
  const agent = useContext(AgentContext);
  const line = useStatusLine();
  const blocked = editingBlockedReason(useWorkspaceState()) !== null;
  const [decision, setDecision] = useState<{ next: string | undefined } | null>(null);
  const [pending, setPending] = useState(false);
  const moving = useRef(false);
  const card = useRef<HTMLElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const nothing = useRef<HTMLParagraphElement>(null);
  const reference = ticket.reference;
  const owner = externalSource(ticket);
  const review = !ticket.trashed && ticket.status === "In review";
  const done = !ticket.trashed && ticket.status === "Done" && decision !== null;
  const canMove = review && !owner && !blocked && !opening;

  function moveToDone() {
    if (!canMove || moving.current) return;
    const request = crypto.randomUUID();
    const undoRequest = crypto.randomUUID();
    // Moving can remove the current row from this filter. Take the queue's
    // order while the reviewed ticket is still in the results.
    const slot = reviewQueue.findIndex((item) => item.reference === reference);
    const queue = [...reviewQueue.slice(slot + 1), ...reviewQueue.slice(0, Math.max(0, slot))];
    const next = queue.find((item) => item.reference !== reference && item.status === "In review")?.reference;
    async function decide() {
      if (moving.current) return;
      moving.current = true;
      setPending(true);
      try {
        const updated = await client.changeTicket(
          reference,
          { status: "Done", expected_status: "In review" },
          request,
        );
        setDecision({ next });
        line.show({
          message: `Moved ${reference} to Done`,
          undo: async () => {
            const restored = await client.changeTicket(
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
        const failure = describeFailure(reason, "move " + reference + " to Done");
        line.show({
          tone: "error",
          message: `${failure.title}. ${failure.sentence}`,
          details: failure.details,
          action: { label: "Retry", run: decide },
        });
        if (failure.code === "conflict") await retry();
      } finally {
        moving.current = false;
        setPending(false);
      }
    }
    void decide();
  }

  const moveOnKey = useEffectEvent((event: KeyboardEvent) => {
    const target = event.target;
    const pane = card.current?.closest(".ticket-detail, .detail-content");
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.repeat ||
      !matchesShortcut(event, "ticket-review-done") ||
      !(target instanceof Element) ||
      !pane?.contains(target) ||
      pane.closest("[hidden], [inert]") ||
      target.closest('input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=textbox]') ||
      document.querySelector('[role=dialog], [role=alertdialog], [role=menu], [role=listbox], [data-slot=popover-content]')
    ) return;
    event.preventDefault();
    moveToDone();
  });
  useEffect(() => {
    if (!active || !canMove) return;
    const press = (event: KeyboardEvent) => moveOnKey(event);
    window.addEventListener("keydown", press);
    return () => window.removeEventListener("keydown", press);
  }, [active, canMove]);
  useLayoutEffect(() => {
    if (active && done) (next.current ?? nothing.current)?.focus();
  }, [active, done]);

  if (done) {
    return (
      <DecisionPanel state="Done">
        <p className="ticket-decision-title">Done · just now · by you</p>
        {decision.next ? (
          <div className="ticket-decision-row">
            <Button ref={next} type="button" variant="outline" size="compact" onClick={() => select(decision.next!)}>
              Next to review
              <ArrowRight aria-hidden="true" />
            </Button>
          </div>
        ) : (
          <p ref={nothing} tabIndex={-1} className="ticket-decision-byline">Nothing else in review</p>
        )}
      </DecisionPanel>
    );
  }
  const latest =
    !ticket.trashed &&
    ticket.status === "In progress" &&
    !agent?.agents.length &&
    agent?.chat?.status.rank !== "working" &&
    agent?.chat?.status.rank !== "approval";
  if (!review && !latest) return null;
  return (
    <DecisionPanel state={review ? "Ready for review" : "Latest update"} cardRef={card}>
      <TicketReport review={review} onAcceptance={onAcceptance} select={select} />
      {latest && <TicketReply active={active} disabled={opening || blocked} />}
      {review && (
        <div className="ticket-decision-row">
          {owner ? (
            <Button asChild variant="outline" size="compact">
              <SourceLink url={owner.url}>Open on {owner.provider_name}</SourceLink>
            </Button>
          ) : (
            <Button
              type="button"
              size="compact"
              disabled={!canMove}
              busy={pending}
              onClick={moveToDone}
              aria-keyshortcuts={ariaKeyShortcuts("ticket-review-done")}
            >
              Move to Done
              <Kbd aria-hidden="true">{shortcutLabel("ticket-review-done")}</Kbd>
            </Button>
          )}
        </div>
      )}
    </DecisionPanel>
  );
}

export function DecisionPanel({
  state,
  cardRef,
  children,
}: {
  state: string;
  cardRef?: React.Ref<HTMLElement>;
  children: ReactNode;
}) {
  return (
    <Card asChild variant="well" className="ticket-decision-card">
      <section ref={cardRef} aria-label={state}>{children}</section>
    </Card>
  );
}

function TicketReport({
  review,
  onAcceptance,
  select,
}: {
  review: boolean;
  onAcceptance: (offset: number) => void;
  select: (reference: string) => void;
}) {
  const { record: ticket } = useOpenTicket();
  const latest = useOpenTicket("latestUpdate");
  const update = latest.value === undefined ? ticket.progress_summary : latest.value;
  const full = useOpenTicket("activityNote", update?.brief.truncated ? update.activity_id : undefined);
  const editingHarness = useEditingHarness();
  const name = update?.editing_agent ?? "You";
  const acceptance = useMemo(
    () => review ? acceptanceSection(withoutBom(ticket.body)) : null,
    [review, ticket.body],
  );
  const state = review ? "Ready for review" : "Latest update";
  return (
    <>
        <h3 className="ticket-decision-title">{state}</h3>
        {update ? (
          <>
            <div className="ticket-decision-byline">
              <HarnessMark harness={editingHarness(name)} name={name} decorative />
              <strong>{name}</strong>
              <span aria-hidden="true">·</span>
              <Time value={update.reported_at} />
            </div>
            <Clamp key={update.activity_id} lines={4} className="ticket-decision-report">
              <MarkdownDocument source={full.value?.brief ?? update.brief.text} select={select} />
            </Clamp>
          </>
        ) : (
          <p className="ticket-decision-byline">
            {latest.value === undefined && !latest.failure ? "Loading update…" : review ? "No report yet" : "No update yet"}
          </p>
        )}
        {acceptance && acceptance.total > 0 && (
          <div className="ticket-decision-row">
            <Button type="button" variant="ghost" size="compact" onClick={() => onAcceptance(acceptance.start)}>
              Acceptance {acceptance.done} of {acceptance.total}
            </Button>
          </div>
        )}
    </>
  );
}
