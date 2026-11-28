import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { ChatSummary } from "@/features/chats/client";
import type { TicketAgent } from "@/features/chats/ticket-agents";
import type { ChatRequest } from "@/features/chats/ticket-chat";
import { useChatFeature } from "@/features/chats/use-chats";
import { matchesShortcut } from "@/lib/shortcuts";

type ChatTarget = {
  chatId: string;
  retention: ChatSummary["retention"];
  subAgent?: string;
};

export type TicketAgentState =
  | {
      kind: "request";
      request: "approval" | "question";
      target: ChatTarget;
      agent?: TicketAgent;
      chat?: ChatSummary;
    }
  | { kind: "stopped"; chat: ChatSummary }
  | { kind: "silent"; chat: ChatSummary; minutes: number }
  | { kind: "working"; agents: TicketAgent[]; chat?: ChatSummary };

export function agentCardName(state: TicketAgentState) {
  return state.kind === "request"
    ? "Request from an agent"
    : "Agents on this ticket";
}

export function agentTarget(agent: TicketAgent): ChatTarget {
  return {
    chatId: agent.chat_id,
    retention: agent.retention,
    ...(agent.sub_agent && { subAgent: agent.sub_agent }),
  };
}

export function openAgentChat(
  { chatId, retention, subAgent }: ChatTarget,
  reference: string,
  view = false,
): ChatRequest {
  return {
    kind: "open",
    chatId,
    retention,
    from: reference,
    ...(view && subAgent && { subAgent }),
  };
}

function chatTarget(state: TicketAgentState): ChatTarget | undefined {
  if (state.kind === "request") return state.target;
  const first = state.kind === "working" ? state.agents[0] : undefined;
  if (first) return agentTarget(first);
  const chat = state.chat;
  return chat && { chatId: chat.id, retention: chat.retention };
}

/** O is scoped to the open Ticket, including its compact header. */
export function useOpenTicketAgentChat(
  state: TicketAgentState | null,
  reference: string,
  active = true,
) {
  const origin = useRef<HTMLElement>(null);
  const { requestChat } = useChatFeature();
  const target = state && chatTarget(state);
  const openChat = () => {
    if (target)
      requestChat(openAgentChat(target, reference, state?.kind === "request"));
  };
  const openOnKey = useEffectEvent((event: KeyboardEvent) => {
    const target = event.target;
    const pane = origin.current?.closest(".ticket-detail, .detail-content");
    if (
      !event.defaultPrevented &&
      !event.isComposing &&
      !event.repeat &&
      matchesShortcut(event, "ticket-agent-chat") &&
      target instanceof Element &&
      pane?.contains(target) &&
      !origin.current?.closest("[hidden], [inert]") &&
      !target.closest(
        "input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=textbox]",
      ) &&
      !document.querySelector(
        "[role=dialog], [role=alertdialog], [role=menu], [role=listbox], [data-slot=popover-content]",
      )
    ) {
      event.preventDefault();
      openChat();
    }
  });
  const chatId = target?.chatId;
  useEffect(() => {
    if (!active || !chatId) return;
    const press = (event: KeyboardEvent) => openOnKey(event);
    window.addEventListener("keydown", press);
    return () => window.removeEventListener("keydown", press);
  }, [active, chatId]);
  return {
    openChat,
    setOrigin: (element: HTMLElement | null) => {
      origin.current = element;
    },
  };
}

function turnIsWorking(chat: ChatSummary) {
  return chat.status.rank === "working" && chat.turn_running !== false;
}

const minute = 60_000;
const silence = 10 * minute;

/** Wake at the first silence threshold, then at the next elapsed minute. */
export function useAgentActivityTime(chats: ChatSummary[]) {
  const [now, setNow] = useState(Date.now);
  let next = Infinity;
  for (const chat of chats) {
    if (!turnIsWorking(chat)) continue;
    const last = Date.parse(chat.updated_at);
    if (!Number.isFinite(last)) continue;
    const wake = Math.max(
      last + silence,
      last + (Math.floor((now - last) / minute) + 1) * minute,
    );
    next = Math.min(next, wake);
  }
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(0, next - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [next, now]);
  return now;
}

/** Only the first state applies. Approvals projected for credited agents also
 * include agents whose Chats have no direct link to the ticket. */
export function agentState(
  chats: ChatSummary[],
  agents: TicketAgent[],
  now: number,
): TicketAgentState | null {
  const asking = agents.find((agent) => agent.approval);
  if (asking)
    return {
      kind: "request",
      request: "approval",
      target: agentTarget(asking),
      agent: asking,
    };
  const approval = chats.find((chat) => chat.status.rank === "approval");
  const question = chats.find((chat) => chat.status.rank === "question");
  const request = approval ?? question;
  if (request)
    return {
      kind: "request",
      request: approval ? "approval" : "question",
      target: { chatId: request.id, retention: request.retention },
      chat: request,
    };
  const stopped = chats.find(
    (chat) => chat.interruption === "stopped" || chat.interruption === "quit",
  );
  if (stopped) return { kind: "stopped", chat: stopped };
  const silent = chats.find(
    (chat) =>
      turnIsWorking(chat) && now - Date.parse(chat.updated_at) >= silence,
  );
  if (silent)
    return {
      kind: "silent",
      chat: silent,
      minutes: Math.floor((now - Date.parse(silent.updated_at)) / minute),
    };
  const working = chats.find((chat) => chat.status.rank === "working");
  return agents.length || working
    ? { kind: "working", agents, ...(working && { chat: working }) }
    : null;
}
