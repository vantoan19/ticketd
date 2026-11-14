import { useEffect, useEffectEvent, useRef, useState } from "react";
import { MessageSquarePlus, SquarePen } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useChatClient,
  type ChatSummary,
  type LinkRef,
} from "@/features/chats/client";
import { ChatStatus } from "@/features/chats/ChatStatus";
import { HarnessMark } from "@/features/chats/HarnessMark";
import { statusLabel } from "@/features/chats/model";
import { addQuote, NEW_CHAT } from "@/features/chats/quotes";
import { useChatFeature } from "@/features/chats/use-chats";

type Selected = {
  text: string;
  source: string;
  record: LinkRef | null;
  element: HTMLElement;
  /** Where the bar sits: the selection's end, kept 16px from the window's edges. */
  left: number;
  top: number;
};

const SETTLE_MS = 250;
/** How long the ⌘L hint stays when nothing is selected. */
const HINT_MS = 2500;
const MAX_CHATS = 4;
const EDGE = 16;

function parseRecord(value: string | undefined): LinkRef | null {
  const [kind, id] = (value ?? "").split(":");
  if (!id || (kind !== "ticket" && kind !== "document" && kind !== "project"))
    return null;
  return { kind, id };
}

const elementOf = (node: Node) =>
  node instanceof Element ? node : node.parentElement;

/**
 * The selection, when it lies inside one quotable source and nowhere editable.
 * A triple-click selects a block up to offset 0 of the block after it, which can
 * lie outside the source: what is selected is still only the source's text, so
 * the range is cut at the source's end.
 */
function readSelection(): Selected | null {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0)
    return null;
  const text = selection.toString().trim();
  if (!text) return null;
  let range = selection.getRangeAt(0);
  const start = elementOf(range.startContainer);
  const source = start?.closest<HTMLElement>("[data-chat-source]");
  if (!source) return null;
  if (!source.contains(range.endContainer)) {
    const inside = range.cloneRange();
    inside.setEnd(source, source.childNodes.length);
    if (inside.toString().trim() !== text) return null;
    range = inside;
  }
  const element = elementOf(range.commonAncestorContainer);
  if (element?.closest("[contenteditable='true'], textarea, input"))
    return null;
  // Not every engine measures ranges (a test document does not); then the bar
  // sits at the source's corner.
  const rects =
    typeof range.getClientRects === "function" ? range.getClientRects() : [];
  const end = rects[rects.length - 1] ?? source.getBoundingClientRect();
  const width = window.innerWidth || 0;
  const height = window.innerHeight || 0;
  return {
    text,
    source: source.dataset.chatSource ?? "",
    record: parseRecord(source.dataset.chatRecord),
    element: source,
    left: Math.max(EDGE, Math.min(end.right, width - 140)),
    top: Math.max(EDGE, Math.min(end.bottom + 4, height - 48)),
  };
}

/** Why a Chat cannot take the quote now, for a linked Chat shown disabled. */
const blocked = (chat: ChatSummary) =>
  chat.problem === "folder_missing" && !chat.problem_past
    ? "Folder missing"
    : null;

/**
 * Add to chat: a small bar at the end of selected rendered text, and ⌘L
 * (Ctrl+L), open a flat menu of up to four Chats, those linked to the source
 * first, then New Chat. Picking one adds the selection to its composer as a
 * quote with its source record, to link when sent; nothing is sent. The bar
 * never takes focus.
 */
export function SelectionAddToChat() {
  const client = useChatClient();
  const { enabled, requestChat } = useChatFeature();
  const [selected, setSelected] = useState<Selected | null>(null);
  const [open, setOpen] = useState(false);
  const [chats, setChats] = useState<{ chat: ChatSummary; linked: boolean }[]>(
    [],
  );
  const [announce, setAnnounce] = useState("");
  /** LIVE-19: ⌘L with nothing selected says how to use it, briefly. */
  const [hint, setHint] = useState(false);
  const menuOpen = useRef(false);
  useEffect(() => {
    if (!hint) return;
    const timer = window.setTimeout(() => setHint(false), HINT_MS);
    return () => window.clearTimeout(timer);
  }, [hint]);

  useEffect(() => {
    if (!enabled) return;
    let timer = 0;
    const settle = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!menuOpen.current) setSelected(readSelection());
      }, SETTLE_MS);
    };
    const shortcut = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "l" ||
        !(event.metaKey || event.ctrlKey) ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const now = readSelection();
      if (!now) {
        // Only where there is text that could be added; elsewhere ⌘L is not ours.
        if (!document.querySelector("[data-chat-source]")) return;
        event.preventDefault();
        setHint(true);
        return;
      }
      event.preventDefault();
      setHint(false);
      setSelected(now);
      menuOpen.current = true;
      setOpen(true);
    };
    document.addEventListener("selectionchange", settle);
    document.addEventListener("keydown", shortcut);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("selectionchange", settle);
      document.removeEventListener("keydown", shortcut);
    };
  }, [enabled]);

  const record = selected?.record ?? null;
  const recordKey = record ? `${record.kind}:${record.id}` : "";
  // The selected record's Chats, read when the record changes (`recordKey`).
  const linkedChats = useEffectEvent(() =>
    record ? client.linkedTo(record) : Promise.resolve([]),
  );
  useEffect(() => {
    if (!open) return;
    let current = true;
    Promise.all([linkedChats(), client.listChats("active")]).then(
      ([mine, recent]) => {
        if (!current) return;
        const rows = mine.map((chat) => ({ chat, linked: true }));
        for (const chat of recent)
          if (!blocked(chat) && !rows.some((row) => row.chat.id === chat.id))
            rows.push({ chat, linked: false });
        setChats(rows.slice(0, MAX_CHATS));
      },
      () => current && setChats([]),
    );
    return () => {
      current = false;
    };
  }, [client, open, recordKey]);

  if (!enabled || !selected)
    return (
      <>
        {enabled && hint && (
          <p className="add-to-chat-hint">Select text to add it to a Chat</p>
        )}
        <div className="sr-only" aria-live="polite">
          {hint ? "Select text to add it to a Chat" : announce}
        </div>
      </>
    );
  const quote = (chatId: string) => {
    addQuote(chatId, {
      source: selected.source,
      text: selected.text,
      record: selected.record,
    });
    setAnnounce(`Quote from ${selected.source} added. Not sent.`);
    setSelected(null);
  };
  return (
    <>
      <div
        className="add-to-chat-bar"
        style={{ left: selected.left, top: selected.top }}
        // Keeps the selection: the bar never takes focus from the text.
        onMouseDown={(event) => event.preventDefault()}
      >
        <DropdownMenu
          open={open}
          onOpenChange={(next) => {
            menuOpen.current = next;
            setOpen(next);
          }}
        >
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    tabIndex={-1}
                    aria-keyshortcuts="Meta+L Control+L"
                  >
                    <MessageSquarePlus aria-hidden />
                    Add to chat
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>Add to chat (⌘L)</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <DropdownMenuContent
            align="start"
            collisionPadding={8}
            onCloseAutoFocus={(event) => {
              // Escape returns to the text the quote came from.
              event.preventDefault();
              selected.element.focus?.();
            }}
          >
            {chats.map(({ chat, linked }) => {
              const reason = linked ? blocked(chat) : null;
              return (
                <DropdownMenuItem
                  key={chat.id}
                  disabled={Boolean(reason)}
                  onSelect={() => {
                    quote(chat.id);
                    requestChat({
                      kind: "open",
                      chatId: chat.id,
                      retention: chat.retention,
                    });
                  }}
                >
                  <HarnessMark
                    harness={chat.harness_id}
                    name={chat.harness_name}
                    className="linked-chats-mark"
                    decorative
                  />
                  <span className="linked-chats-item">
                    <span className="linked-chats-item-title">
                      {chat.title}
                    </span>
                    {reason ? (
                      <span className="chat-status">
                        <span className="chat-status-word">{reason}</span>
                      </span>
                    ) : (
                      <ChatStatus
                        status={{
                          ...chat.status,
                          word: statusLabel(chat.status),
                          detail: null,
                        }}
                        activity={chat.activity}
                      />
                    )}
                  </span>
                </DropdownMenuItem>
              );
            })}
            {chats.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem
              onSelect={() => {
                quote(NEW_CHAT);
                requestChat({ kind: "new" });
              }}
            >
              <SquarePen aria-hidden />
              New Chat
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="sr-only" aria-live="polite">
        {announce}
      </div>
    </>
  );
}
