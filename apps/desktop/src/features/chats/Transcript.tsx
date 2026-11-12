import { memo, useEffect, useState } from "react";
import {
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  FilePlus2,
  FileText,
  Info,
  LoaderCircle,
  MessageSquareText,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Reference } from "@/components/ui/reference";
import { useCopy } from "@/components/ui/use-copy";
import { MarkdownDocument } from "@/features/markdown/MarkdownDocument";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import type {
  ChatState,
  RecordChange,
  RequestAnswer,
  Step,
  TranscriptItem,
} from "@/features/chats/client";
import { binarySize, elapsed, stepTally } from "@/features/chats/model";

type Of<K extends TranscriptItem["kind"]> = Extract<
  TranscriptItem,
  { kind: K }
>;

/** What transcript items can ask of the Chat that owns them. Keep the object stable. */
export type TranscriptActions = {
  answer: (requestId: string, answer: RequestAnswer) => void;
  saveAsDocument: (response: Of<"response">) => void;
};

const DELIVERY_CAPTION = {
  // Saved here is not the same as received there.
  sending: "Sending…",
  delivered: "",
  not_sent: "Not sent",
  uncertain: "Not confirmed",
  set_aside: "Not confirmed · set aside",
} as const;

function UserMessage({ item }: { item: Of<"user"> }) {
  const caption = DELIVERY_CAPTION[item.delivery];
  return (
    <>
      <div
        className="chat-you"
        data-unsent={item.delivery === "delivered" ? undefined : ""}
      >
        <span className="sr-only">You: </span>
        {item.text}
      </div>
      {caption && <div className="chat-caption">{caption}</div>}
    </>
  );
}

function Response({
  item,
  harness,
  readOnly,
  actions,
}: {
  item: Of<"response">;
  harness: string;
  readOnly: boolean;
  actions: TranscriptActions;
}) {
  const { copied, error, copy } = useCopy();
  return (
    <div className="chat-turn">
      <div className="chat-ai">
        <span className="sr-only">{harness}: </span>
        <MarkdownDocument source={item.text} />
      </div>
      {item.state === "partial" && (
        <p className="chat-fine">
          Incomplete. ticketd closed before the rest of this response was saved.
        </p>
      )}
      {item.state === "complete" && (
        <div className="chat-actions">
          <IconButton
            label="Copy response"
            onClick={() => void copy("Response", item.text)}
          >
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          </IconButton>
          {!readOnly && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => actions.saveAsDocument(item)}
            >
              <FilePlus2 aria-hidden /> Save as Document
            </Button>
          )}
          <span className="chat-fine" role="status">
            {copied && "Copied"}
            {error}
          </span>
        </div>
      )}
    </div>
  );
}

const VERB = { read: "Read", edited: "Edited", ran: "Ran", other: "" } as const;

function StepRow({ step, harness }: { step: Step; harness: string }) {
  return (
    <li>
      {step.verb === "other" ? (
        step.target
      ) : (
        <>
          {VERB[step.verb]} <code>{step.target}</code>
        </>
      )}
      {step.more > 0 && ` and ${step.more} more`}
      {step.result && <small>{step.result}</small>}
      {step.output && <pre className="chat-out">{step.output}</pre>}
      {step.truncated && (
        <p className="chat-fine">
          Truncated: ticketd keeps the last{" "}
          {binarySize(step.truncated.kept_bytes)} of{" "}
          {binarySize(step.truncated.total_bytes)}. {harness} saw all of it.
        </p>
      )}
    </li>
  );
}

function Steps({ item, harness }: { item: Of<"steps">; harness: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="chat-steps"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {stepTally(item.steps)}
        {open ? (
          <ChevronDown size={14} aria-hidden />
        ) : (
          <ChevronRight size={14} aria-hidden />
        )}
      </button>
      {open && (
        <ul className="chat-steplist">
          {item.steps.map((step, index) => (
            <StepRow key={index} step={step} harness={harness} />
          ))}
        </ul>
      )}
    </>
  );
}

function RecordRow({ change }: { change: RecordChange }) {
  if (change.kind === "status")
    return (
      <li>
        <StatusIcon status={change.to} decorative />
        <span className="chat-rec-main">
          <Reference>{change.reference}</Reference> {change.title}
        </span>
        <span className="chat-rec-what">
          {change.from} → {change.to}
        </span>
      </li>
    );
  if (change.kind === "update")
    return (
      <li>
        <MessageSquareText size={16} aria-hidden />
        <span className="chat-rec-main">
          <Reference>{change.reference}</Reference> “{change.excerpt}”
        </span>
        <span className="chat-rec-what">Update posted</span>
      </li>
    );
  return (
    <li>
      <FileText size={16} aria-hidden />
      <span className="chat-rec-main">{change.title}</span>
      <span className="chat-rec-what">Document created</span>
    </li>
  );
}

const receiptTime = (timestamp: string) => {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? ""
    : ` · ${date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })}`;
};

const APPROVAL_VARIANTS = ["default", "outline", "ghost"] as const;

/**
 * An approval or question. Only a pending card has controls: an answered one
 * is a receipt and an expired one says so, because a callback that belonged
 * to an earlier turn or process can no longer be answered.
 */
function RequestCard({
  item,
  harness,
  actions,
}: {
  item: Of<"request">;
  harness: string;
  actions: TranscriptActions;
}) {
  const pending = item.state === "pending";
  const label = !pending
    ? item.state === "answered"
      ? "Answered request"
      : "Expired request"
    : item.request === "approval"
      ? "Approval request"
      : `Question from ${harness}`;
  return (
    <section className="chat-card" aria-label={label}>
      <h3 className="chat-card-title">{item.title}</h3>
      {item.subject &&
        (item.request === "question" ? (
          // A question is prose; only a command or path is set in code.
          <p className="chat-card-text">{item.subject}</p>
        ) : (
          <pre className="chat-code">{item.subject}</pre>
        ))}
      {/* Why the harness asks is prose, apart from what would run. */}
      {item.reason && <p className="chat-card-text">{item.reason}</p>}
      {pending && item.request === "approval" && (
        <div className="chat-card-actions">
          {item.options.map((option, index) => (
            <Button
              key={option.id}
              size="sm"
              variant={APPROVAL_VARIANTS[Math.min(index, 2)]}
              onClick={() => actions.answer(item.id, { option_id: option.id })}
            >
              {option.label}
            </Button>
          ))}
        </div>
      )}
      {pending && item.request === "question" && (
        <>
          <div className="chat-opts">
            {item.options.map((option) => (
              <button
                key={option.id}
                type="button"
                className="chat-opt"
                onClick={() =>
                  actions.answer(item.id, { option_id: option.id })
                }
              >
                {option.label}
                {option.description && <small>{option.description}</small>}
              </button>
            ))}
          </div>
          {item.free_text && (
            <p className="chat-fine">Or type your own answer below.</p>
          )}
        </>
      )}
      {item.state === "answered" && (
        <p className="chat-line">
          {/* The host words a denial "You denied this"; it gets no check mark. */}
          {item.outcome?.startsWith("You denied") ? (
            <Ban size={14} aria-hidden />
          ) : (
            <Check size={14} aria-hidden />
          )}
          {item.outcome ?? "Answered"}
          {item.resolved_at && receiptTime(item.resolved_at)}
        </p>
      )}
      {item.state === "expired" && (
        <p className="chat-line">
          <Clock size={14} aria-hidden />
          Expired. The turn ended before this was answered.
        </p>
      )}
    </section>
  );
}

function markerText(item: Of<"marker">, harness: string) {
  const detail = item.message ? ` ${item.message}` : "";
  switch (item.reason) {
    case "stopped":
      return `You stopped this turn. Edits already made are kept.${detail}`;
    case "quit":
      return `Stopped when ticketd quit. Edits already made are kept.${detail}`;
    case "stop_unconfirmed":
      return `ticketd asked ${harness} to stop but it didn't confirm. It may still be running.${detail}`;
    case "failed":
      return `This turn failed.${detail || ` ${harness} gave no reason.`} What it finished before that is kept.`;
    case "note":
      return item.message ?? "";
  }
}

const SESSION_HISTORY = {
  last_response: () => "the last response",
  last_messages: (count: number) => `the last ${count} messages`,
  all: () => "the whole conversation",
  picked: (count: number) =>
    `${count} picked ${count === 1 ? "message" : "messages"}`,
} as const;

const Item = memo(function Item({
  item,
  harness,
  readOnly,
  actions,
}: {
  item: TranscriptItem;
  harness: string;
  readOnly: boolean;
  actions: TranscriptActions;
}) {
  switch (item.kind) {
    case "user":
      return <UserMessage item={item} />;
    case "response":
      return (
        <Response
          item={item}
          harness={harness}
          readOnly={readOnly}
          actions={actions}
        />
      );
    case "steps":
      return <Steps item={item} harness={harness} />;
    case "records":
      return (
        <div className="chat-records">
          <span className="chat-fine" id={`records-${item.id}`}>
            Updated in ticketd
          </span>
          <ul aria-labelledby={`records-${item.id}`}>
            {item.changes.map((change, index) => (
              <RecordRow key={index} change={change} />
            ))}
          </ul>
        </div>
      );
    case "request":
      return <RequestCard item={item} harness={harness} actions={actions} />;
    case "marker":
      return item.reason === "note" ? (
        <p className="chat-line chat-note">
          <Info size={14} aria-hidden />
          <span>
            <span className="sr-only">ticketd: </span>
            {item.message}
          </span>
        </p>
      ) : (
        <p className="chat-line">
          {/* Filled, the stop sign does not read as an empty checkbox. */}
          <Square size={12} fill="currentColor" aria-hidden />
          <span>{markerText(item, harness)}</span>
        </p>
      );
    case "session":
      return (
        <div className="chat-divider" role="separator">
          Fresh session · started with{" "}
          {SESSION_HISTORY[item.history](item.count)}
        </div>
      );
  }
});

/** The live step and how long it has run. The clock is not read out every second. */
function WorkingLine({ label, since }: { label: string; since?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [since]);
  const started = since ? new Date(since).getTime() : NaN;
  return (
    <div className="chat-working" role="status">
      <LoaderCircle size={14} className="chat-spin" aria-hidden />
      <span>
        {label}
        {!Number.isNaN(started) && (
          <span aria-hidden="true"> · {elapsed(now - started)}</span>
        )}
      </span>
    </div>
  );
}

const excerpt = (text: string) =>
  text.length > 60 ? `${text.slice(0, 60)}…` : text;

/**
 * The conversation, in the order things happened. In pick mode it becomes the
 * history picker of "Resume in a fresh session": only messages, each with a
 * checkbox.
 */
export function Transcript({
  chat,
  items,
  actions,
  picked,
  onPick,
}: {
  chat: ChatState;
  items: TranscriptItem[];
  actions: TranscriptActions;
  /** Set while picking history; holds the chosen message ids. */
  picked?: ReadonlySet<string> | undefined;
  onPick?: (id: string, include: boolean) => void;
}) {
  const harness = chat.harness.name;
  const readOnly = chat.retention === "trashed";
  if (picked)
    return (
      <div className="chat-col">
        {items.map(
          (item) =>
            (item.kind === "user" || item.kind === "response") && (
              <div key={item.id} className="chat-pickrow">
                <input
                  type="checkbox"
                  checked={picked.has(item.id)}
                  aria-label={
                    item.kind === "user"
                      ? `Include your message: ${excerpt(item.text)}`
                      : `Include the reply: ${excerpt(item.text)}`
                  }
                  onChange={(event) => onPick?.(item.id, event.target.checked)}
                />
                <div>
                  <Item
                    item={item}
                    harness={harness}
                    readOnly
                    actions={actions}
                  />
                </div>
              </div>
            ),
        )}
      </div>
    );
  const working = chat.activity === "working";
  return (
    <div className="chat-col">
      {items.map((item) => (
        <Item
          key={item.id}
          item={item}
          harness={harness}
          readOnly={readOnly}
          actions={actions}
        />
      ))}
      {chat.catching_up && (
        <>
          <div className="chat-skel chat-skel-long" aria-hidden="true" />
          <div className="chat-skel chat-skel-short" aria-hidden="true" />
        </>
      )}
      {chat.catching_up ? (
        <WorkingLine label="Catching up…" />
      ) : (
        working && (
          <WorkingLine
            label={chat.doing?.label ?? "Working…"}
            {...(chat.doing && { since: chat.doing.since })}
          />
        )
      )}
    </div>
  );
}
