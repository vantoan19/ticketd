import {
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { StatusDot } from "@/components/ui/status-dot";
import { Time } from "@/components/ui/time";
import { useStatusLine } from "@/components/ui/use-status-line";
import { HarnessMark } from "@/features/chats/HarnessMark";
import {
  useChatClient,
  type ChatSummary,
  type TranscriptItem,
} from "@/features/chats/client";
import { stepWords } from "@/features/chats/model";
import { agentName } from "@/features/chats/ticket-agents";
import { useChat } from "@/features/chats/use-chats";
import type { LatestUpdate } from "@/lib/api/progress";
import { ariaKeyShortcuts, shortcutLabel } from "@/lib/shortcuts";
import { Elapsed, TicketAgentsLabel } from "./TicketAgentsLabel";
import {
  useOpenTicketAgentChat,
  type TicketAgentState,
} from "./ticket-agent-state";

export function TicketAgentCard({
  state,
  reference,
  active,
  report,
  onOpenUpdate,
}: {
  state: TicketAgentState;
  reference: string;
  active: boolean;
  report: LatestUpdate | null;
  onOpenUpdate: (id: string) => void;
}) {
  const first = state.kind === "working" ? state.agents[0] : undefined;
  const { openChat, setOrigin } = useOpenTicketAgentChat(
    state,
    reference,
    active,
  );
  const open = (
    <Button
      variant={state.kind === "request" ? "ghost" : "outline"}
      size="compact"
      onClick={openChat}
      aria-keyshortcuts={ariaKeyShortcuts("ticket-agent-chat")}
    >
      Open Chat
      <Kbd aria-hidden="true">{shortcutLabel("ticket-agent-chat")}</Kbd>
    </Button>
  );
  return (
    <div ref={setOrigin} className="ticket-agent-content">
      {state.kind === "request" ? (
        <AgentRequest key={state.target.chatId} state={state} open={open} />
      ) : (
        <>
          {state.kind === "working" ? (
            <div
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className="ticket-agent-content"
            >
              {first ? (
                <TicketAgentsLabel
                  agents={state.agents}
                  reference={reference}
                />
              ) : (
                state.chat && (
                  <WorkingChat key={state.chat.id} chat={state.chat} />
                )
              )}
            </div>
          ) : (
            <>
              <p className="ticket-decision-line ticket-decision-title">
                <StatusDot tone="neutral" size={6} />
                {state.kind === "silent"
                  ? `No word from ${agentName(state.chat)} for ${state.minutes} min`
                  : `${agentName(state.chat)} stopped`}
              </p>
              <p className="ticket-decision-byline">
                {state.kind === "silent"
                  ? "The turn is still running. Open Chat to see its last step."
                  : "The turn ended. Open Chat to see where it stopped."}
              </p>
            </>
          )}
          <div className="ticket-decision-row">{open}</div>
          {state.kind === "working" && report && (
            <div className="ticket-decision-byline ticket-agent-last-report">
              <span>
                Last report <Time value={report.reported_at} /> from{" "}
                {report.editing_agent ?? "You"}
              </span>
              <span aria-hidden="true">·</span>
              <Button
                variant="ghost"
                size="compact"
                onClick={() => onOpenUpdate(report.activity_id)}
              >
                Show
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function useAgentChat(id: string) {
  const chat = useChat(id);
  const { show } = useStatusLine();
  const reportFailure = useEffectEvent(() => {
    if (chat.error)
      show({
        tone: "error",
        message: chat.error.sentence,
        action: { label: "Retry", run: chat.retry },
      });
  });
  useEffect(() => {
    if (chat.error) reportFailure();
  }, [chat.error]);
  return chat.snapshot;
}

/** A linked Chat can be working before the host has an agent record for it. */
function WorkingChat({ chat }: { chat: ChatSummary }) {
  const snapshot = useAgentChat(chat.id);
  const step = snapshot?.items
    .flatMap((item) => (item.kind === "steps" && !item.owner ? item.steps : []))
    .reverse()
    .find((step) => step.state === "running");
  const detail = step
    ? stepWords(step)
        .parts.map((part) => part.text)
        .filter(Boolean)
        .join(" ")
    : (snapshot?.chat.doing?.label ?? chat.status.detail);
  const started = step?.started_at ?? snapshot?.chat.doing?.since;
  return (
    <>
      <div className="ticket-decision-line ticket-decision-title">
        <HarnessMark
          harness={chat.harness_id}
          name={chat.harness_name}
          decorative
        />
        <span>{agentName(chat)} is working on this ticket</span>
      </div>
      {(detail || started) && (
        <p className="ticket-decision-byline">
          {detail}
          {started && <Elapsed started={started} />}
        </p>
      )}
    </>
  );
}

type PendingRequest = Extract<TranscriptItem, { kind: "request" }>;

function approvalTitle(request: PendingRequest | undefined, name: string) {
  if (!request || request.command || request.title.endsWith("wants to run"))
    return `${name} wants to run`;
  return request.owner ? `${name} ${request.title}` : request.title;
}

function AgentRequest({
  state,
  open,
}: {
  state: Extract<TicketAgentState, { kind: "request" }>;
  open: React.ReactNode;
}) {
  const snapshot = useAgentChat(state.target.chatId);
  const request = snapshot?.items.find(
    (item): item is PendingRequest =>
      item.kind === "request" &&
      item.state === "pending" &&
      item.request === state.request &&
      (!state.agent ||
        (item.owner ?? null) === (state.agent.sub_agent ?? null)),
  );
  const asker =
    state.agent ??
    snapshot?.chat.sub_agents.find((agent) => agent.id === request?.owner) ??
    state.chat;
  const name =
    asker && "harness_name" in asker
      ? agentName(asker)
      : (asker?.model ?? snapshot?.chat.harness.name ?? "An agent");
  const approval = state.request === "approval";
  const command =
    request?.command ?? request?.subject ?? state.agent?.approval?.summary;
  const folder =
    request?.folder ?? snapshot?.chat.folder.path ?? state.chat?.folder_name;
  const title = approval
    ? approvalTitle(request, name)
    : (request?.subject ?? request?.title ?? "A question from an agent");
  const announcement = (
    <div role="alert" className="ticket-agent-content">
      <p className="ticket-decision-line ticket-decision-title">
        <StatusDot tone="attention" size={6} />
        {title}
      </p>
      {approval && command && (
        <code className="ticket-agent-command chat-mono">{command}</code>
      )}
      {approval && (folder || request?.at) && (
        <p className="ticket-decision-byline">
          {folder && <span>{folder}</span>}
          {folder && request?.at && <span aria-hidden="true">·</span>}
          {request?.at && (
            <span>
              asked <Time value={request.at} />
            </span>
          )}
        </p>
      )}
    </div>
  );
  return approval && request ? (
    <ApprovalChoices
      key={request.id}
      request={request}
      chatId={state.target.chatId}
      announcement={announcement}
    >
      {open}
    </ApprovalChoices>
  ) : (
    <>
      {announcement}
      <div className="ticket-decision-row">{open}</div>
    </>
  );
}

function ApprovalChoices({
  request,
  chatId,
  announcement,
  children,
}: {
  request: PendingRequest;
  chatId: string;
  announcement: React.ReactNode;
  children: React.ReactNode;
}) {
  const client = useChatClient();
  const choiceId = useId();
  const inFlight = useRef(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const pick = (optionId: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPicked(optionId);
    setFailed(false);
    void client
      .answer(chatId, request.id, { option_id: optionId })
      .catch(() => {
        inFlight.current = false;
        setPicked(null);
        setFailed(true);
      });
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.defaultPrevented ||
      event.nativeEvent.isComposing ||
      event.repeat ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      !/^[1-3]$/.test(event.key) ||
      !event.currentTarget.contains(document.activeElement)
    )
      return;
    const option = request.options[Number(event.key) - 1];
    if (!option) return;
    event.preventDefault();
    event.stopPropagation();
    pick(option.id);
  };
  return (
    <div className="ticket-agent-content" onKeyDown={onKey}>
      {announcement}
      {failed && (
        <p role="status" className="ticket-decision-byline">
          Answer not sent · Pick again to retry
        </p>
      )}
      <div className="ticket-decision-row ticket-approval-choices">
        {request.options.map((option, index) => {
          const warningId = option.warning ? `${choiceId}-${index}` : undefined;
          return (
            <div
              className="grid min-w-0 justify-items-start gap-1"
              key={option.id}
            >
              <Button
                type="button"
                size="compact"
                variant="outline"
                disabled={picked !== null}
                busy={picked === option.id}
                onClick={() => pick(option.id)}
                aria-keyshortcuts={index < 3 ? String(index + 1) : undefined}
                aria-describedby={warningId}
              >
                {option.label === "Allow for this session"
                  ? "Allow in this Chat"
                  : option.label}
                {index < 3 && <Kbd aria-hidden="true">{index + 1}</Kbd>}
              </Button>
              {option.warning && (
                <p
                  id={warningId}
                  className="ticket-decision-byline max-w-40 whitespace-pre-wrap wrap-anywhere"
                >
                  {option.warning}
                </p>
              )}
            </div>
          );
        })}
        {children}
      </div>
    </div>
  );
}
