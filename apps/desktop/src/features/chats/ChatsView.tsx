import { useLayoutEffect, useRef, useState } from "react";
import { Check, Ellipsis, LoaderCircle, SquarePen } from "lucide-react";
import { Count } from "@/components/ui/count";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { ListHeader } from "@/components/ui/list-header";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { StatusDot } from "@/components/ui/status-dot";
import { useNarrowPane } from "@/features/tickets/useNarrowPane";
import { useNow } from "@/lib/use-now";
import type { ChatSummary, Retention } from "@/features/chats/client";
import { useTakenOverLine } from "@/features/automations/use-taken-over-line";
import { ChatDetail } from "@/features/chats/ChatDetail";
import { chatTime, summaryLine } from "@/features/chats/model";
import { NewChat } from "@/features/chats/NewChat";
import { useChatList } from "@/features/chats/use-chats";

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

function ChatRow({
  chat,
  active,
  now,
  onOpen,
}: {
  chat: ChatSummary;
  active: boolean;
  now: number;
  onOpen: () => void;
}) {
  const line = summaryLine(chat);
  const context = [chat.first_ticket, chat.folder_name]
    .filter(Boolean)
    .join(" · ");
  return (
    <li>
      <button
        type="button"
        className="chat-row"
        aria-current={active ? "true" : undefined}
        data-attention={chat.needs_you ? "" : undefined}
        onClick={onOpen}
      >
        <span className="chat-row-mark">
          {chat.needs_you ? (
            <StatusDot tone="attention" />
          ) : (
            chat.activity === "working" && (
              <LoaderCircle size={14} className="chat-spin" aria-hidden />
            )
          )}
        </span>
        <span className="chat-row-title">{chat.title}</span>
        <span className="chat-row-time">{chatTime(chat.updated_at, now)}</span>
        <span className="chat-row-sub">
          <span>{chat.needs_you ? <strong>{line}</strong> : line}</span>
          {context && <span>{context}</span>}
        </span>
      </button>
    </li>
  );
}

type Open = { kind: "chat"; id: string } | { kind: "new" } | null;

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
  const takenOver = useTakenOverLine(open?.kind === "chat" ? open.id : null);
  const [expanded, setExpanded] = useState(false);
  const [seenRequest, setSeenRequest] = useState(0);
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
  useLayoutEffect(() => {
    if (focusDetail.current) document.getElementById("chat-heading")?.focus();
    focusDetail.current = false;
  }, [openKey]);
  const show = (next: Open) => {
    focusDetail.current = single && next !== null;
    if (!next) setExpanded(false);
    setOpen(next);
  };

  const listPane = (
    <section className="ticket-list chat-pane" aria-label="Chat list">
      <ListHeader
        title={current?.title ?? "Chats"}
        actions={
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label="Show active, archived or trashed Chats">
                  <Ellipsis aria-hidden />
                </IconButton>
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
      </ListHeader>
      {list?.error && (
        <p className="chat-list-empty" role="alert">
          Could not load Chats: {list.error}
        </p>
      )}
      {list && !list.error && list.chats.length === 0 && (
        <p className="chat-list-empty">{current?.empty}</p>
      )}
      <ul className="chat-rows" aria-label="Chats">
        {list?.chats.map((chat) => (
          <ChatRow
            key={chat.id}
            chat={chat}
            now={now}
            active={open?.kind === "chat" && open.id === chat.id}
            onOpen={() => show({ kind: "chat", id: chat.id })}
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
        {...paneProps}
        onCreated={(id) => {
          setScope("active");
          show({ kind: "chat", id });
        }}
      />
    ) : open ? (
      <ChatDetail
        key={open.id}
        id={open.id}
        notice={takenOver}
        {...paneProps}
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
