import { useState, type ReactNode, type Ref } from "react";
import { Square } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import type { LinkRef } from "@/features/chats/client";
import { linksOf, type Token } from "@/features/chats/composer-mentions";
import {
  ComposerField,
  type ComposerMentions,
} from "@/features/chats/ComposerField";
import type { ComposerControls } from "@/features/chats/model";
import { SendButton } from "@/features/chats/SendButton";

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
  onArrowUpFromEmpty,
  inputRef,
  autoFocus = false,
}: {
  placeholder: string;
  /** Computed from the text the composer reports through `onText`. */
  controls: (text: string) => ComposerControls;
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
  onSend: (text: string, links: LinkRef[]) => Promise<void>;
  onQueue?: (text: string, links: LinkRef[]) => Promise<void>;
  /** Pass only while a turn is in progress. */
  onStop?: () => void;
  /** Stop was asked for and has not finished: Stop waits. */
  stopping?: boolean;
  /** ↑ in an empty box: what is above it (a request's options) takes focus. */
  onArrowUpFromEmpty?: () => void;
  inputRef?: Ref<HTMLTextAreaElement>;
  autoFocus?: boolean;
}) {
  const [text, setTextState] = useState(initialText);
  const [tokens, setTokens] = useState(initialTokens);
  const [busy, setBusy] = useState(false);
  const setText = (next: string, nextTokens: Token[] = []) => {
    setTextState(next);
    setTokens(nextTokens);
    onText?.(next, nextTokens);
  };
  const state = controls(text);
  const submit = (
    action: ((text: string, links: LinkRef[]) => Promise<void>) | undefined,
  ) => {
    const message = text.trim();
    if (!action || !message || busy) return;
    setBusy(true);
    action(message, linksOf(tokens)).then(
      () => {
        setText("");
        setBusy(false);
      },
      () => setBusy(false),
    );
  };
  const primary = state.send === "queue" ? onQueue : onSend;
  const queue = () => {
    if (state.queues) submit(onQueue);
  };
  return (
    <form
      className="chat-composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (state.enabled) submit(primary);
      }}
    >
      {above}
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
      {/* The left of the row is for the harness's own controls (#368). */}
      <div className="chat-composer-row">
        <span className="chat-spacer" />
        {onStop && (
          <IconButton
            type="button"
            variant="outline"
            label="Stop"
            shortcut="Esc"
            aria-keyshortcuts="Escape"
            disabled={stopping}
            onClick={onStop}
          >
            {/* Filled, the stop sign does not read as an empty checkbox. */}
            <Square fill="currentColor" aria-hidden />
          </IconButton>
        )}
        <SendButton
          controls={state}
          busy={busy}
          onSteer={() => submit(onSend)}
          onQueue={queue}
        />
      </div>
    </form>
  );
}
