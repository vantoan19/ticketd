import {
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type Ref,
} from "react";
import { Paperclip, RotateCcw, Square, X } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import type { LinkRef } from "@/features/chats/client";
import { linksOf, type Token } from "@/features/chats/composer-mentions";
import {
  ComposerField,
  type ComposerMentions,
} from "@/features/chats/ComposerField";
import type { ComposerControls } from "@/features/chats/model";
import { SendButton } from "@/features/chats/SendButton";
import {
  NO_ATTACHMENTS,
  type ChatAttachmentInput,
  type ComposerAttachments,
} from "@/features/chats/composer-attachments";

type Submit = (
  text: string,
  links: LinkRef[],
  files?: ChatAttachmentInput[],
) => Promise<void>;

/**
 * The message box and its control row. The send button's word comes from
 * `controls`; the text is kept until the action it was typed for succeeds, so
 * a refused send never loses what was written. Enter does what the button
 * says, Shift+Enter adds a line, Cmd/Ctrl+Enter queues while a turn runs.
 * Stop shows whenever `onStop` is given, whatever is typed.
 */
export function Composer({
  placeholder,
  controls,
  initialText = "",
  initialTokens = [],
  onText,
  mentions,
  above,
  onSend,
  onQueue,
  onStop,
  stopping = false,
  beforeStop,
  leading,
  onArrowUpFromEmpty,
  inputRef,
  autoFocus = false,
  framed = true,
  retryRef,
  attachments = NO_ATTACHMENTS,
}: {
  /**
   * Draws its own ring. In a Chat the composer is the last part of the tray,
   * which draws the one ring for the notice, the dock and the box (CH-22).
   */
  framed?: boolean;
  /** Repeats the refused action with the current draft, including Queue. */
  retryRef?: Ref<() => void>;
  placeholder: string;
  /** Computed from the text the composer reports through `onText`. */
  controls: (text: string, hasAttachments: boolean) => ComposerControls;
  initialText?: string;
  initialTokens?: Token[];
  onText?: (text: string, tokens: Token[]) => void;
  /** The `#`, `@` and `/` menus; without it the box is plain text. */
  mentions?: ComposerMentions | undefined;
  /** Shown inside the box above the text, such as quotes added to the Chat. */
  above?: ReactNode;
  /**
   * Send, steer or answer. Resolve to clear the box; reject to keep the text.
   * `links` are the records mentioned with `#`, linked as the message is sent.
   */
  onSend: Submit;
  onQueue?: Submit;
  attachments?: ComposerAttachments;
  /** Pass only while a turn is in progress. */
  onStop?: () => void;
  /** Stop was asked for and has not finished: Stop waits. */
  stopping?: boolean;
  /** Fixed before Stop, so Send leads: the context count. */
  beforeStop?: ReactNode;
  /** The row's start: the harness's model and permission triggers (#368). */
  leading?: ReactNode;
  /** ↑ in an empty box: what is above it (a request's options) takes focus. */
  onArrowUpFromEmpty?: () => void;
  inputRef?: Ref<HTMLTextAreaElement>;
  autoFocus?: boolean;
}) {
  const [text, setTextState] = useState(initialText);
  const [tokens, setTokens] = useState(initialTokens);
  const [busy, setBusy] = useState(false);
  const filePicker = useRef<HTMLInputElement>(null);
  const [failedAction, setFailedAction] = useState<"send" | "queue" | null>(
    null,
  );
  const setText = (next: string, nextTokens: Token[] = []) => {
    setTextState(next);
    setTokens(nextTokens);
    onText?.(next, nextTokens);
  };
  const items = useSyncExternalStore(
    attachments.subscribe,
    attachments.snapshot,
  );
  const files = items.flatMap((item) =>
    item.state === "ready" ? [item.content] : [],
  );
  const waiting = items.length !== files.length;
  const available = controls(text, items.length > 0);
  const state = waiting
    ? { ...available, enabled: false, queues: false }
    : available;
  const submit = (action: Submit | undefined) => {
    const message = text.trim();
    if (!action || (!message && !files.length) || waiting || busy) return;
    setBusy(true);
    const links = linksOf(tokens);
    const sent = files.length
      ? action(message, links, files)
      : action(message, links);
    sent.then(
      () => {
        setText("");
        if (items.length)
          attachments.remove(new Set(items.map((item) => item.id)));
        setFailedAction(null);
        setBusy(false);
      },
      () => {
        setFailedAction(action === onQueue ? "queue" : "send");
        setBusy(false);
      },
    );
  };
  useImperativeHandle(retryRef, () => () => {
    if (
      failedAction === "queue" &&
      (state.queues || (state.send === "queue" && state.enabled))
    )
      submit(onQueue);
    else if (failedAction === "send" && state.send !== "queue" && state.enabled)
      submit(onSend);
  });
  const primary = state.send === "queue" ? onQueue : onSend;
  const queue = () => {
    if (state.queues) submit(onQueue);
  };
  return (
    <form
      className="chat-composer"
      data-bare={framed ? undefined : ""}
      onSubmit={(event) => {
        event.preventDefault();
        if (state.enabled) submit(primary);
      }}
      onPaste={(event) => {
        if (attachments === NO_ATTACHMENTS) return;
        const image =
          Array.from(event.clipboardData.files).find((file) =>
            file.type.startsWith("image/"),
          ) ??
          Array.from(event.clipboardData.items ?? [])
            .find(
              (item) => item.kind === "file" && item.type.startsWith("image/"),
            )
            ?.getAsFile();
        if (!image) return;
        event.preventDefault();
        attachments.add([image]);
      }}
    >
      {above}
      {items.length > 0 && (
        <ul
          className="flex flex-wrap gap-2 px-3 pt-2"
          aria-label="Message attachments"
        >
          {items.map((item) => (
            <li
              key={item.id}
              className="flex min-w-0 items-center gap-2 rounded-md border px-2 py-1 text-xs"
            >
              {item.state === "ready" &&
                item.content.dataUrl.startsWith("data:image/") && (
                  <img
                    className="h-12 w-16 rounded-sm object-contain"
                    src={item.content.dataUrl}
                    alt={item.name}
                  />
                )}
              <span className="truncate">{item.name}</span>
              {item.state === "capturing" && (
                <span role="status">Capturing…</span>
              )}
              {item.state === "failed" && (
                <>
                  <span role="alert">{item.error}</span>
                  <IconButton
                    type="button"
                    variant="ghost"
                    size="icon-compact"
                    label={`Retry ${item.name}`}
                    onClick={() => attachments.retry(item.id)}
                  >
                    <RotateCcw aria-hidden />
                  </IconButton>
                </>
              )}
              <IconButton
                type="button"
                variant="ghost"
                size="icon-compact"
                label={`Remove ${item.name}`}
                disabled={busy}
                onClick={() => attachments.remove(new Set([item.id]))}
              >
                <X aria-hidden />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <ComposerField
        inputRef={inputRef}
        placeholder={placeholder}
        text={text}
        tokens={tokens}
        mentions={mentions}
        autoFocus={autoFocus}
        onChange={setText}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (
            event.key === "ArrowUp" &&
            onArrowUpFromEmpty &&
            text === "" &&
            !event.shiftKey
          ) {
            event.preventDefault();
            onArrowUpFromEmpty();
            return;
          }
          if (event.key !== "Enter" || event.shiftKey) return;
          event.preventDefault();
          if ((event.metaKey || event.ctrlKey) && state.queues !== undefined)
            queue();
          else if (state.enabled) submit(primary);
        }}
      />
      {/* The harness's own controls lead and give up width first; the row
          never wraps, so the composer keeps one height as a turn starts and
          ends (STATIC-6). */}
      <div className="chat-composer-row">
        {leading}
        <div className="chat-composer-end">
          {attachments !== NO_ATTACHMENTS && (
            <>
              <input
                ref={filePicker}
                type="file"
                multiple
                hidden
                aria-label="Choose files to attach"
                onChange={(event) => {
                  if (!busy)
                    attachments.add(
                      Array.from(event.currentTarget.files ?? []),
                    );
                  event.currentTarget.value = "";
                }}
              />
              <IconButton
                type="button"
                variant="ghost"
                size="icon-compact"
                label="Attach files"
                disabled={busy}
                onClick={() => filePicker.current?.click()}
              >
                <Paperclip aria-hidden />
              </IconButton>
            </>
          )}
          {beforeStop}
          {onStop && (
            <IconButton
              type="button"
              variant="ghost"
              size="icon-compact"
              label="Stop"
              shortcut="Esc"
              aria-keyshortcuts="Escape"
              disabled={stopping}
              onClick={onStop}
            >
              {/* Filled and small, the stop sign does not read as a checkbox. */}
              <Square
                className="chat-stop-mark"
                fill="currentColor"
                aria-hidden
              />
            </IconButton>
          )}
          <SendButton
            controls={state}
            busy={busy}
            onSteer={() => submit(onSend)}
            onQueue={queue}
          />
        </div>
      </div>
    </form>
  );
}
