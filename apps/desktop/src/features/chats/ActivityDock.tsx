import {
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
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import type { ChatState } from "@/features/chats/client";
import { requestChoices as choices } from "@/features/chats/dock-focus";
import { requestLabel, type PendingRequest } from "@/features/chats/model";

type Queued = ChatState["queue"][number];

function Request({
  request,
  position,
  count,
  onAnswer,
  onLeave,
  focusTitle = false,
}: {
  request: PendingRequest;
  position: number;
  count: number;
  /** Take focus on the title when shown: the Chat was opened from its notification. */
  focusTitle?: boolean;
  onAnswer: (optionId: string) => Promise<void>;
  /** ↓ from the last choice, or an answer: focus goes back to the message box. */
  onLeave: () => void;
}) {
  const titleId = useId();
  const reasonId = useId();
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusTitle) title.current?.focus();
  }, [focusTitle]);
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const question = request.request === "question";
  const pick = (optionId: string) => {
    if (sending) return;
    setSending(optionId);
    setError("");
    onAnswer(optionId).then(
      () => {
        setSending(null);
        onLeave();
      },
      (reason: unknown) => {
        setSending(null);
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };
  const Icon = question ? MessageCircleQuestion : ShieldQuestion;
  return (
    <section
      role="group"
      className="chat-request"
      aria-labelledby={titleId}
      {...(request.reason && { "aria-describedby": reasonId })}
      onKeyDown={(event) => {
        const list = choices(event.currentTarget);
        const at = list.indexOf(event.target as HTMLButtonElement);
        if (at < 0 || event.altKey || event.metaKey || event.ctrlKey) return;
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
        {count > 1 && (
          <span className="chat-request-count">
            {position} of {count}
          </span>
        )}
      </div>
      <div className="chat-request-body">
        {request.reason && (
          <p id={reasonId} className="chat-request-reason">
            {request.reason}
          </p>
        )}
        {question ? (
          <div className="chat-request-options">
            {request.options.map((option, index) => (
              <button
                key={option.id}
                type="button"
                data-choice=""
                className="chat-option"
                disabled={sending !== null}
                aria-keyshortcuts={index < 9 ? String(index + 1) : undefined}
                onClick={() => pick(option.id)}
              >
                <span>{option.label}</span>
                {option.description && <small>{option.description}</small>}
                {sending === option.id && (
                  <LoaderCircle size={12} className="chat-spin" aria-hidden />
                )}
              </button>
            ))}
          </div>
        ) : (
          <div className="chat-request-buttons">
            {request.options.map((option, index) => (
              <Button
                key={option.id}
                type="button"
                variant="outline"
                size="sm"
                data-choice=""
                disabled={sending !== null}
                aria-keyshortcuts={index < 9 ? String(index + 1) : undefined}
                onClick={() => pick(option.id)}
              >
                {option.label}
                {sending === option.id && (
                  <LoaderCircle size={12} className="chat-spin" aria-hidden />
                )}
              </Button>
            ))}
          </div>
        )}
        {error && (
          <p className="chat-request-error" role="alert">
            Not sent: {error.replace(/\.$/, "")}. Pick again to retry.
          </p>
        )}
      </div>
    </section>
  );
}

function QueueCard({
  queued,
  canSendNow,
  onSendNow,
  onEdit,
  onRemove,
}: {
  queued: Queued;
  canSendNow: boolean;
  onSendNow: () => Promise<void>;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const textId = useId();
  const [sending, setSending] = useState(false);
  return (
    <li className="chat-queue-card">
      <span className="chat-queue-main">
        <span id={textId} className="chat-queue-text">
          {queued.text}
        </span>
        {queued.refused_steer && (
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
          <IconButton
            label="Edit in the message box"
            aria-describedby={textId}
            onClick={onEdit}
          >
            <Pencil aria-hidden />
          </IconButton>
          <IconButton
            label="Remove from queue"
            aria-describedby={textId}
            onClick={onRemove}
          >
            <X aria-hidden />
          </IconButton>
        </span>
      )}
    </li>
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
  onLeave,
  onSendNow,
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
  onAnswer: (requestId: string, optionId: string) => Promise<void>;
  onLeave: () => void;
  onSendNow: (queuedId: string) => Promise<void>;
  onEdit: (queued: Queued) => void;
  onRemove: (queuedId: string) => void;
  onResume: () => void;
}) {
  const request = requests[0];
  const { queue, queue_paused: paused } = chat;
  if (!request && !plan && queue.length === 0) return null;
  // During a turn that cannot be steered, a queued message can only wait.
  const live = chat.activity === "working" || chat.activity === "waiting";
  const canSendNow = !live || chat.steering.available;
  return (
    <div ref={dockRef} className="chat-activity">
      {request && (
        <Request
          key={request.id}
          request={request}
          position={1}
          count={requests.length}
          onAnswer={(optionId) => onAnswer(request.id, optionId)}
          onLeave={onLeave}
          focusTitle={focusRequest}
        />
      )}
      {plan && <section className="chat-activity-slot">{plan}</section>}
      {queue.length > 0 && (
        <section className="chat-queue">
          <div className="chat-queue-head">
            <span>Queued {queue.length}</span>
            <span className="chat-queue-caption">
              {paused ? "Paused" : "After this turn"}
            </span>
            {paused && (
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
            {queue.map((queued) => (
              <QueueCard
                key={queued.id}
                queued={queued}
                canSendNow={canSendNow}
                onSendNow={() => onSendNow(queued.id)}
                onEdit={() => onEdit(queued)}
                onRemove={() => onRemove(queued.id)}
              />
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
