import { cn } from "cn";
import { FailureAlert, FailureState } from "@/components/ui/failure-alert";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import {
  CornerUpRight,
  LoaderCircle,
  MessageCircleQuestion,
  Pencil,
  ShieldQuestion,
  X,
} from "lucide-react";
import { Presence } from "@/components/ui/motion";
import { Rise, Space } from "@/features/chats/arrivals";
import { Button } from "@/components/ui/button";
import { Count } from "@/components/ui/count";
import { CopyButton } from "@/components/ui/copy-button";
import { Kbd } from "@/components/ui/kbd";
import { Time } from "@/components/ui/time";
import { Disclosure } from "@/components/ui/disclosure";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import type { ChatState, RequestAnswer } from "@/features/chats/client";
import type {
  AnswerDraft,
  QuestionDrafts,
} from "@/features/chats/question-drafts";
import { requestChoices as choices } from "@/features/chats/dock-focus";
import {
  canSteer,
  recordNamer,
  requestLabel,
  ticketdParts,
  type PendingRequest,
  type RecordName,
} from "@/features/chats/model";

type Queued = ChatState["queue"][number];

function Request({
  request,
  position,
  count,
  onAnswer,
  onLeave,
  onAnswered,
  name,
  answerInComposer,
  answerDraft,
  questionDrafts,
  focusTitle = false,
}: {
  request: PendingRequest;
  /** Names the Chat's linked records by their titles. */
  name: RecordName;
  position: number;
  count: number;
  /** Take focus on the title when shown: the Chat was opened from its notification. */
  focusTitle?: boolean;
  onAnswer: (answer: RequestAnswer) => Promise<void>;
  answerInComposer: boolean;
  answerDraft?: AnswerDraft | undefined;
  questionDrafts: QuestionDrafts;
  /** Successful answers can return to the view that opened the Chat. */
  onAnswered?: (requestId: string, origin: Element | null) => void;
  /** ↓ from the last choice, Esc, or an answer: focus goes back to the message box. */
  onLeave: () => void;
}) {
  const titleId = useId();
  const reasonId = useId();
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusTitle) title.current?.focus();
  }, [focusTitle]);
  const sending = answerDraft?.pending ?? null;
  const text = answerDraft?.text ?? "";
  const [error, setError] = useState<FailureDescription | null>(null);
  const [showCommand, setShowCommand] = useState(false);
  const question = request.request === "question";
  const showAnswerField = question && request.free_text && !answerInComposer;
  // What runs exactly, when the title says it as sentences or shortened.
  const exact =
    request.command ?? (request.ticketd?.length ? request.subject : undefined);
  const submit = (answer: RequestAnswer) => {
    if (!questionDrafts.begin(request.id, answer, answerInComposer)) return;
    const origin = document.activeElement;
    setError(null);
    onAnswer(answer).then(
      () => {
        questionDrafts.settle(request.id, answer, true);
        if (onAnswered) onAnswered(request.id, origin);
        else onLeave();
      },
      (reason: unknown) => {
        questionDrafts.settle(request.id, answer, false);
        const failure = describeFailure(reason, "send your answer");
        // Picking again is the retry.
        setError({
          ...failure,
          sentence:
            question && "option_id" in answer
              ? `${failure.sentence} Pick again to retry.`
              : failure.sentence,
        });
      },
    );
  };
  const pick = (option_id: string) => submit({ option_id });
  const selected = sending && "option_id" in sending ? sending.option_id : null;
  const commandDisclosure = exact ? (
    <div className="chat-request-command">
      <Disclosure
        label="Command"
        open={showCommand}
        onOpenChange={setShowCommand}
      >
        {showCommand && (
          <div className="chat-request-command-box">
            <pre className="chat-out">{exact}</pre>
            <CopyButton text={exact} label="Copy command" />
          </div>
        )}
      </Disclosure>
    </div>
  ) : null;
  const Icon = question ? MessageCircleQuestion : ShieldQuestion;
  return (
    <Rise
      role="group"
      data-request={request.request}
      aria-labelledby={titleId}
      {...(request.reason &&
        (question || !error) && { "aria-describedby": reasonId })}
      onKeyDown={(event) => {
        // Portaled Details owns its keys and returns focus to its own trigger.
        if (!event.currentTarget.contains(event.target as Node)) return;
        // Esc inside a request goes back to the message box (CH-54).
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          onLeave();
          return;
        }
        const list = choices(event.currentTarget);
        const at = list.indexOf(event.target as HTMLButtonElement);
        // Opening an approval from Inbox or a notification focuses its title
        // so the request is announced before the person chooses an answer.
        if (
          (at < 0 && event.target !== title.current) ||
          event.altKey ||
          event.metaKey ||
          event.ctrlKey ||
          event.nativeEvent.isComposing
        )
          return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const next = at + (event.key === "ArrowDown" ? 1 : -1);
          if (next >= list.length) onLeave();
          else list[Math.max(0, next)]?.focus();
        } else if (/^[1-9]$/.test(event.key)) {
          const option = request.options[Number(event.key) - 1];
          if (!option) return;
          event.preventDefault();
          pick(option.id);
        }
      }}
    >
      <div className="chat-request-head">
        <Icon size={16} aria-hidden />
        {/* Focusable so a notification can bring the person straight to it. */}
        <h3
          ref={title}
          id={titleId}
          className="chat-request-title"
          tabIndex={-1}
        >
          {question ? (
            requestLabel(request)
          ) : request.ticketd?.length ? (
            <>
              {request.title}{" "}
              {ticketdParts(request.ticketd, 2, name, true).map(
                (part, index) => (
                  <Fragment key={index}>
                    {index > 0 && part.text !== "," && " "}
                    {part.code ? (
                      <code className="chat-mono">{part.text}</code>
                    ) : (
                      part.text
                    )}
                  </Fragment>
                ),
              )}
            </>
          ) : (
            <>
              {request.title}
              {/* The host words the title so the subject follows inline. */}
              {request.subject && (
                <>
                  {" "}
                  <code className="chat-mono">{request.subject}</code>
                </>
              )}
            </>
          )}
        </h3>
        {!question && (
          <span className="shrink-0 text-xs text-muted-foreground">
            Asked <Time value={request.at} />
          </span>
        )}
        {count > 1 && (
          <span className="chat-request-count">
            {position} of {count}
          </span>
        )}
      </div>
      <div className="chat-request-body">
        {!question && !request.ticketd?.length && request.command && (
          <pre className="chat-out">{request.command}</pre>
        )}
        {question ? (
          request.reason && (
            <p id={reasonId} className="chat-request-reason">
              <CodeSpans text={request.reason} />
            </p>
          )
        ) : (
          <div className="chat-approval-feedback">
            {request.reason && (
              <p
                id={reasonId}
                className={cn(
                  "chat-request-reason text-xs",
                  error && "invisible",
                )}
                aria-hidden={error ? true : undefined}
              >
                <CodeSpans text={request.reason} />
              </p>
            )}
            <div
              className={cn(!error && "invisible")}
              aria-hidden={!error ? true : undefined}
            >
              <FailureState
                size="inline"
                label="Answer not sent"
                detailsVariant="popover"
                failure={error ?? describeFailure("", "send your answer")}
                actions={<span>Pick again to retry.</span>}
              />
            </div>
          </div>
        )}
        {question && commandDisclosure}
        {question ? (
          <div className="chat-request-options">
            {request.options.map((option, index) => (
              // A plain 40px row: label, muted description, a spinner while
              // sending. 1–9 still pick, with no key badge (CH-23).
              <button
                key={option.id}
                type="button"
                data-choice=""
                className="chat-option"
                disabled={sending !== null}
                data-selected={selected === option.id ? "" : undefined}
                aria-pressed={selected === option.id}
                aria-keyshortcuts={index < 9 ? String(index + 1) : undefined}
                onClick={() => pick(option.id)}
              >
                <span>{option.label}</span>
                {option.description && <small>{option.description}</small>}
                {selected === option.id && (
                  <LoaderCircle size={12} className="chat-spin" aria-hidden />
                )}
              </button>
            ))}
          </div>
        ) : (
          <div className="chat-request-buttons">
            {request.options.map((option, index) => {
              const warningId = `${titleId}-warning-${index}`;
              return (
                <div key={option.id} className="chat-approval-choice">
                  <Button
                    type="button"
                    variant="outline"
                    size="compact"
                    data-choice=""
                    disabled={sending !== null}
                    aria-describedby={option.warning ? warningId : undefined}
                    aria-keyshortcuts={
                      index < 9 ? String(index + 1) : undefined
                    }
                    onClick={() => pick(option.id)}
                  >
                    {option.label}
                    {index < 3 ? (
                      <Kbd aria-hidden="true" className="w-5">
                        {selected === option.id ? (
                          <LoaderCircle size={12} className="chat-spin" />
                        ) : (
                          index + 1
                        )}
                      </Kbd>
                    ) : selected === option.id ? (
                      <LoaderCircle
                        size={12}
                        className="chat-spin"
                        aria-hidden
                      />
                    ) : null}
                  </Button>
                  {option.warning && (
                    <p
                      id={warningId}
                      className="chat-approval-warning text-xs text-muted-foreground"
                    >
                      {option.warning}
                    </p>
                  )}
                </div>
              );
            })}
            {commandDisclosure}
          </div>
        )}
        {showAnswerField && (
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (text.trim()) submit({ text: text.trim() });
            }}
          >
            <Input
              aria-label="Answer"
              placeholder="Type your answer"
              value={text}
              readOnly={sending !== null}
              onChange={(event) =>
                questionDrafts.setText(request.id, event.target.value)
              }
            />
            <Button
              type="submit"
              size="compact"
              disabled={!text.trim() || sending !== null}
            >
              Send answer
            </Button>
          </form>
        )}
        {question && error && <FailureAlert size="compact" failure={error} />}
      </div>
    </Rise>
  );
}

function QueueCard({
  queued,
  canSendNow,
  adopted,
  canRemove,
  onSendNow,
  onEdit,
  onRemove,
}: {
  queued: Queued;
  canSendNow: boolean;
  adopted: boolean;
  canRemove: boolean;
  onSendNow: () => Promise<void>;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const textId = useId();
  const [sending, setSending] = useState(false);
  return (
    // Its own space closes with its fade, so the cards below glide up.
    <Space as="li" className="chat-queue-card">
      <Rise className="flex w-full items-center min-h-8">
        <span className="chat-queue-main">
          <span id={textId} className="chat-queue-text">
            {[
              queued.text,
              ...(queued.attachments?.map((file) => file.name) ?? []),
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          {queued.editing && <span className="chat-queue-note">Editing</span>}
          {!queued.editing && queued.refused_steer && (
            <span className="chat-queue-note">
              Couldn't steer; queued · {queued.refused_steer}
            </span>
          )}
        </span>
        {sending ? (
          <span className="chat-queue-sending">Sending…</span>
        ) : (
          <span className="chat-queue-actions">
            {canSendNow && (
              <IconButton
                label="Send now"
                aria-describedby={textId}
                onClick={() => {
                  setSending(true);
                  // On success the card leaves the queue; on failure it stays.
                  onSendNow().catch(() => setSending(false));
                }}
              >
                <CornerUpRight aria-hidden />
              </IconButton>
            )}
            {!adopted && (
              <IconButton
                label="Edit in the message box"
                aria-describedby={textId}
                onClick={onEdit}
              >
                <Pencil aria-hidden />
              </IconButton>
            )}
            <IconButton
              label="Remove from queue"
              disabled={!canRemove}
              aria-describedby={textId}
              onClick={onRemove}
            >
              <X aria-hidden />
            </IconButton>
          </span>
        )}
      </Rise>
    </Space>
  );
}

/**
 * Everything that needs the person, seated on the composer: the pending
 * request, the plan pill (#367), then the queue. Not drawn when there is
 * nothing to show. A request never takes focus from the message box.
 */
export function ActivityDock({
  chat,
  requests,
  plan,
  dockRef,
  onAnswer,
  composerQuestion,
  answerDraft,
  questionDrafts,
  onLeave,
  onAnswered,
  onSendNow,
  queueEdits,
  draftLocked,
  onEdit,
  onRemove,
  onResume,
  focusRequest = false,
}: {
  chat: ChatState;
  /** The Chat was opened from a notification: the shown request's title takes focus. */
  focusRequest?: boolean;
  /** Pending requests, oldest first; the first one is shown. */
  requests: PendingRequest[];
  /** The plan pill, when the turn has a plan. */
  plan?: ReactNode;
  dockRef?: Ref<HTMLDivElement>;
  onAnswer: (requestId: string, answer: RequestAnswer) => Promise<void>;
  composerQuestion?: string | undefined;
  answerDraft?: AnswerDraft | undefined;
  questionDrafts: QuestionDrafts;
  onLeave: () => void;
  onAnswered?: (requestId: string, origin: Element | null) => void;
  onSendNow: (queuedId: string) => Promise<void>;
  queueEdits: readonly string[];
  draftLocked: boolean;
  onEdit: (queuedId: string) => void;
  onRemove: (queuedId: string) => void;
  onResume: () => void;
}) {
  const request = requests[0];
  const { queue, queue_paused: paused } = chat;
  const waiting = queue.filter((queued) => !queued.editing).length;
  // During a turn that cannot be steered, a queued message can only wait.
  const live = chat.activity === "working" || chat.activity === "waiting";
  // Always drawn (empty it takes no room): a request or the queue that leaves
  // fades out here while the tray closes its space (DockSlot).
  return (
    <div ref={dockRef} className="chat-activity">
      {/* One request at a time: the next waits for the answered one to leave. */}
      <Presence initial={false} mode="wait">
        {request && (
          <Request
            key={request.id}
            request={request}
            position={1}
            count={requests.length}
            onAnswer={(answer) => onAnswer(request.id, answer)}
            answerInComposer={composerQuestion === request.id}
            answerDraft={answerDraft}
            questionDrafts={questionDrafts}
            onLeave={onLeave}
            {...(onAnswered && { onAnswered })}
            name={recordNamer(chat.links)}
            focusTitle={focusRequest}
          />
        )}
      </Presence>
      {plan && <section className="chat-activity-slot">{plan}</section>}
      <Presence initial={false}>
        {queue.length > 0 && (
          <QueueSection key="queue">
            <div className="chat-queue-head">
              {waiting ? (
                <span>
                  Queued <Count>{waiting}</Count> ·{" "}
                  {paused ? "Paused" : "After this turn"}
                </span>
              ) : (
                <span>Saved for editing</span>
              )}
              {paused && waiting > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  onClick={onResume}
                >
                  Resume
                </Button>
              )}
            </div>
            <ol aria-label="Queued messages">
              <Presence initial={false}>
                {queue.map((queued) => (
                  <QueueCard
                    key={queued.id}
                    queued={queued}
                    adopted={queueEdits.includes(queued.id)}
                    canRemove={!draftLocked}
                    canSendNow={
                      !queued.editing &&
                      (!live ||
                        canSteer(
                          chat,
                          queued.attachments?.some((file) =>
                            file.media_type.startsWith("image/"),
                          ),
                        ))
                    }
                    onSendNow={() => onSendNow(queued.id)}
                    onEdit={() => onEdit(queued.id)}
                    onRemove={() => onRemove(queued.id)}
                  />
                ))}
              </Presence>
            </ol>
          </QueueSection>
        )}
      </Presence>
    </div>
  );
}

/** The queue's section: it fades up with its first card and out with its last. */
function QueueSection({ children }: { children: ReactNode }) {
  return (
    <Space>
      <Rise>
        <section className="chat-queue">{children}</section>
      </Rise>
    </Space>
  );
}

/** Sets a harness's `code spans` in mono; unbalanced backticks stay as written. */
function CodeSpans({ text }: { text: string }) {
  const parts = text.split("`");
  if (parts.length % 2 === 0) return text;
  return parts.map((part, index) =>
    index % 2 ? (
      <code key={index} className="chat-mono">
        {part}
      </code>
    ) : (
      part
    ),
  );
}
