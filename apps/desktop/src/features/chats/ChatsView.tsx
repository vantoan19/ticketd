import { useContext, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  BellOff,
  Check,
  ChevronDown,
  SquarePen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Reference } from "@/components/ui/reference";
import { TicketNavigation } from "@/features/tickets/navigation";
import type { TicketStart } from "@/features/chats/ticket-chat";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Count } from "@/components/ui/count";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { PaneHeader } from "@/components/ui/list-header";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useNarrowPane } from "@/features/tickets/useNarrowPane";
import { useNow } from "@/lib/use-now";
import type { ChatSummary, Retention } from "@/features/chats/client";
import { ChatDetail } from "@/features/chats/ChatDetail";
import { ChatActionsMenu } from "@/features/chats/ChatActionsMenu";
import { ChatStatus } from "@/features/chats/ChatStatus";
import { HarnessMark } from "@/features/chats/HarnessMark";
import { ProjectIcon } from "@/features/projects/ProjectIcon";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import { chatTime, emphasised } from "@/features/chats/model";
import { NewChat } from "@/features/chats/NewChat";
import { useChatFeature, useChatList } from "@/features/chats/use-chats";

const SCOPES: { id: Retention; menu: string; title: string; empty: string }[] =
  [
    {
      id: "active",
      menu: "Active",
      title: "Chats",
      empty: "No Chats yet. Start one with New Chat.",
    },
    {
      id: "archived",
      menu: "Archived",
      title: "Archived",
      empty: "No archived Chats.",
    },
    {
      id: "trashed",
      menu: "Trash",
      title: "Trash",
      empty: "No Chats in Trash.",
    },
  ];
/** The list pane's 360px plus the detail pane's 480px: below this one pane shows. */
const STACK_MIN_WIDTH = 840;
const PANEL_STYLE = {
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
} as const;

/**
 * Line two's one context item: the first linked ticket's status icon and
 * reference, with "+N" for the rest, else the Project. It gives way first.
 */
function RowContext({ chat }: { chat: ChatSummary }) {
  const [ticket, ...more] = chat.tickets;
  if (ticket)
    return (
      <span className="chat-row-context">
        <StatusIcon status={ticket.status} size={12} decorative />
        <Reference>{ticket.reference}</Reference>
        {more.length > 0 && <span>+{more.length}</span>}
      </span>
    );
  if (chat.project)
    return (
      <span className="chat-row-context">
        <ProjectIcon project={chat.project} />
        <span className="chat-row-context-name">{chat.project.title}</span>
      </span>
    );
  return null;
}

/**
 * MOTION-14: the list is one Tab stop. Up and Down move between rows, Home and
 * End to the ends, Right Arrow to the row's actions and Left back to the row.
 */
function moveInList(event: React.KeyboardEvent<HTMLElement>) {
  const from = event.target as HTMLElement;
  const list = from.closest(".chat-rows");
  if (!list) return;
  const rows = Array.from(list.querySelectorAll<HTMLElement>(".chat-row"));
  const row = from
    .closest(".chat-row-item")
    ?.querySelector<HTMLElement>(".chat-row");
  const at = row ? rows.indexOf(row) : -1;
  const go = (index: number) => {
    event.preventDefault();
    rows[Math.max(0, Math.min(rows.length - 1, index))]?.focus();
  };
  if (event.key === "ArrowDown") go(at + 1);
  else if (event.key === "ArrowUp") go(at - 1);
  else if (event.key === "Home") go(0);
  else if (event.key === "End") go(rows.length - 1);
  else if (event.key === "ArrowRight" && from === row) {
    event.preventDefault();
    from
      .closest(".chat-row-item")
      ?.querySelector<HTMLElement>(".chat-row-more button")
      ?.focus();
  } else if (event.key === "ArrowLeft" && from !== row) {
    event.preventDefault();
    row?.focus();
  }
}

function ChatRow({
  chat,
  active,
  tabStop,
  now,
  onOpen,
  onResult,
}: {
  chat: ChatSummary;
  active: boolean;
  /** The row the list's one Tab stop lands on. */
  tabStop: boolean;
  now: number;
  onOpen: () => void;
  onResult: (failure: string) => void;
}) {
  const row = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const strong = emphasised(chat.status);
  const more = useRef<HTMLSpanElement>(null);
  // The actions are reached with Right Arrow, not Tab.
  useLayoutEffect(() => {
    more.current?.querySelector("button")?.setAttribute("tabindex", "-1");
  });
  return (
    <li className="chat-row-item" onKeyDown={moveInList}>
      <button
        ref={row}
        type="button"
        className="chat-row"
        tabIndex={tabStop ? 0 : -1}
        aria-current={active ? "true" : undefined}
        data-attention={strong ? "" : undefined}
        onClick={onOpen}
        onKeyDown={(event) => {
          // The standard keys for a context menu open the row's actions.
          if (
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")
          ) {
            event.preventDefault();
            setMenu(true);
          }
        }}
      >
        {/* Said after the title: a row reads title, harness, status, context, time. */}
        <HarnessMark
          harness={chat.harness_id}
          name={chat.harness_name}
          className="chat-row-mark"
          decorative
        />
        <span className="chat-row-title">
          {chat.title}
          <span className="sr-only">, {chat.harness_name},</span>
        </span>
        <span className="chat-row-time">
          {chat.muted && <BellOff size={14} aria-hidden="true" />}
          {chatTime(chat.updated_at, now)}
        </span>
        <span className="chat-row-sub">
          <ChatStatus status={chat.status} activity={chat.activity} />
          <RowContext chat={chat} />
        </span>
        {chat.status.unseen && <span className="sr-only">, unread</span>}
        {chat.muted && <span className="sr-only">, muted</span>}
      </button>
      <span
        ref={more}
        className="chat-row-more"
        data-open={menu ? "" : undefined}
      >
        <ChatActionsMenu
          chat={{ ...chat, unseen: chat.status.unseen }}
          label={`Actions for ${chat.title}`}
          open={menu}
          onOpenChange={setMenu}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            row.current?.focus();
          }}
          onResult={onResult}
        />
      </span>
    </li>
  );
}

type Open =
  | {
      kind: "chat";
      id: string;
      from?: string;
      /** Opened from a system notification: its pending request takes focus. */
      notified?: boolean;
    }
  | { kind: "new"; start?: TicketStart; n?: number }
  | null;

/** "← T-KQ12 /": back to the ticket the Chat was opened from. */
function TicketCrumb({ reference }: { reference: string }) {
  const openTicket = useContext(TicketNavigation);
  return (
    <Button
      variant="ghost"
      size="xs"
      aria-label={`Back to ${reference}`}
      onClick={() => openTicket?.(reference)}
    >
      <ArrowLeft aria-hidden />
      <Reference>{reference}</Reference>
      <span aria-hidden="true">/</span>
    </Button>
  );
}

/**
 * The Chats screen: the list of one scope beside the open Chat or New Chat,
 * in the same split the ticket workspace uses. Leaving this screen detaches
 * the view only; the host keeps the work running.
 */
export function ChatsView({
  newChatRequest = 0,
}: {
  /** Rises when New Chat is chosen elsewhere, such as the sidebar's compose menu. */
  newChatRequest?: number;
}) {
  const [scope, setScope] = useState<Retention>("active");
  const [open, setOpen] = useState<Open>(null);
  const [expanded, setExpanded] = useState(false);
  const [seenRequest, setSeenRequest] = useState(0);
  const [failure, setFailure] = useState("");
  // A clicked notification opens its Chat under its own list, title focused.
  const { openRequest, chatRequest } = useChatFeature();
  const [seenOpen, setSeenOpen] = useState(openRequest?.n ?? 0);
  if (openRequest && seenOpen !== openRequest.n) {
    setSeenOpen(openRequest.n);
    setScope(openRequest.request.retention);
    setOpen({
      kind: "chat",
      id: openRequest.request.chat_id,
      notified: true,
    });
  }
  // A Chat asked for from a ticket: opened with a crumb back, or New Chat about it.
  const [seenChat, setSeenChat] = useState(chatRequest?.n ?? 0);
  if (chatRequest && seenChat !== chatRequest.n) {
    setSeenChat(chatRequest.n);
    const request = chatRequest.request;
    if (request.kind === "open") {
      setScope(request.retention);
      setOpen({
        kind: "chat",
        id: request.chatId,
        ...(request.from && { from: request.from }),
      });
    } else {
      setScope("active");
      setOpen({
        kind: "new",
        ...(request.start && { start: request.start }),
        n: chatRequest.n,
      });
    }
  }
  if (seenRequest !== newChatRequest) {
    setSeenRequest(newChatRequest);
    setScope("active");
    setOpen({ kind: "new" });
  }
  const list = useChatList(scope);
  const now = useNow();
  const workspaceRef = useRef<HTMLDivElement>(null);
  const narrow = useNarrowPane(workspaceRef, STACK_MIN_WIDTH);
  const single = narrow || expanded;
  const current = SCOPES.find((item) => item.id === scope) ?? SCOPES[0];
  const openKey = open?.kind === "chat" ? open.id : open?.kind;
  // Opening a Chat moves focus to its title where the list is no longer beside it.
  const focusDetail = useRef(false);
  const focusedOpen = useRef(seenOpen);
  useLayoutEffect(() => {
    if (focusDetail.current || focusedOpen.current !== seenOpen)
      document.getElementById("chat-heading")?.focus();
    focusDetail.current = false;
    focusedOpen.current = seenOpen;
  }, [openKey, seenOpen]);
  const show = (next: Open) => {
    focusDetail.current = single && next !== null;
    if (!next) setExpanded(false);
    setOpen(next);
  };

  const listPane = (
    <section className="ticket-list chat-pane" aria-label="Chat list">
      <PaneHeader
        title={current?.title ?? "Chats"}
        actions={
          <>
            {/* LIVE-18: a labelled filter, not a "⋯" that reads as actions. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Chats shown: ${current?.menu ?? "Active"}`}
                >
                  {current?.menu ?? "Active"}
                  <ChevronDown aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {SCOPES.map((item) => (
                  <DropdownMenuItem
                    key={item.id}
                    aria-current={item.id === scope ? "true" : undefined}
                    onSelect={() => {
                      setScope(item.id);
                      show(null);
                    }}
                  >
                    {item.menu}
                    {item.id === scope && (
                      <Check className="ml-auto" aria-hidden />
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <IconButton label="New Chat" onClick={() => show({ kind: "new" })}>
              <SquarePen aria-hidden />
            </IconButton>
          </>
        }
      >
        {list && (
          <Count>
            {list.chats.length}
            <span className="sr-only"> chats</span>
          </Count>
        )}
      </PaneHeader>
      {failure && (
        <div className="chat-list-alert">
          <Alert tone="error">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        </div>
      )}
      {list?.error && (
        <p className="chat-list-empty" role="alert">
          Could not load Chats: {list.error}
        </p>
      )}
      {list && !list.error && list.chats.length === 0 && (
        <p className="chat-list-empty">{current?.empty}</p>
      )}
      <ul className="chat-rows" aria-label="Chats">
        {list?.chats.map((chat, index) => (
          <ChatRow
            key={chat.id}
            chat={chat}
            now={now}
            active={open?.kind === "chat" && open.id === chat.id}
            tabStop={
              list.chats.some(
                (one) => open?.kind === "chat" && open.id === one.id,
              )
                ? open?.kind === "chat" && open.id === chat.id
                : index === 0
            }
            onOpen={() => show({ kind: "chat", id: chat.id })}
            onResult={setFailure}
          />
        ))}
      </ul>
    </section>
  );
  const paneProps = {
    expanded,
    single,
    onExpand: () => setExpanded(true),
    onReturn: () => {
      // Expanded returns to the split; a narrow window returns to the list.
      if (expanded) setExpanded(false);
      else show(null);
    },
    onClose: () => show(null),
  };
  const detailPane =
    open?.kind === "new" ? (
      <NewChat
        key={open.n ?? 0}
        {...paneProps}
        {...(open.start && {
          start: open.start,
          crumb: <TicketCrumb reference={open.start.ticket.reference} />,
        })}
        onCreated={(id) => {
          setScope("active");
          show({ kind: "chat", id });
        }}
      />
    ) : open ? (
      <ChatDetail
        key={open.id}
        id={open.id}
        {...paneProps}
        {...(open.from && { crumb: <TicketCrumb reference={open.from} /> })}
        focusRequest={Boolean(open.notified)}
      />
    ) : (
      <section className="ticket-detail chat-pane" aria-label="No Chat open">
        <p className="chat-list-empty">Open a Chat, or start a new one.</p>
      </section>
    );
  return (
    <div ref={workspaceRef} className="plan-workspace">
      {single ? (
        <div className="ticket-workspace chats-workspace">
          {open ? detailPane : listPane}
        </div>
      ) : (
        <div className="ticket-workspace chats-workspace">
          <ResizablePanelGroup orientation="horizontal">
            <ResizablePanel id="chat-list" minSize={360} defaultSize={384}>
              {listPane}
            </ResizablePanel>
            <ResizableHandle aria-label="Resize Chat list" />
            <ResizablePanel id="chat-detail" minSize={480} style={PANEL_STYLE}>
              {detailPane}
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      )}
    </div>
  );
}
