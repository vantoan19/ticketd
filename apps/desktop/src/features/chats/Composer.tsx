import { useState } from "react";
import { ArrowUp, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import type { ComposerControls } from "@/features/chats/model";

/**
 * The message box and its one button group. Which buttons show is decided by
 * `controls`; the text is kept until the action it was typed for succeeds, so
 * a refused send never loses what was written. Enter sends, Shift+Enter adds
 * a line.
 */
export function Composer({
  placeholder,
  controls,
  initialText = "",
  onText,
  onSend,
  onQueue,
  onStop,
  autoFocus = false,
}: {
  placeholder: string;
  /** Computed from the text the composer reports through `onText`. */
  controls: (text: string) => ComposerControls;
  initialText?: string;
  onText?: (text: string) => void;
  /** Resolve to clear the box; reject to keep the text. */
  onSend: (text: string) => Promise<void>;
  onQueue?: (text: string) => Promise<void>;
  onStop?: () => void;
  autoFocus?: boolean;
}) {
  const [text, setTextState] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const setText = (next: string) => {
    setTextState(next);
    onText?.(next);
  };
  const state = controls(text);
  const submit = (action: ((text: string) => Promise<void>) | undefined) => {
    const message = text.trim();
    if (!action || !message || busy) return;
    setBusy(true);
    action(message).then(
      () => {
        setText("");
        setBusy(false);
      },
      () => setBusy(false),
    );
  };
  const primary =
    state.kind === "queue-only"
      ? onQueue
      : state.kind === "steer" || (state.kind === "send" && state.enabled)
        ? onSend
        : undefined;
  return (
    <>
      <form
        className="chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          submit(primary);
        }}
      >
        <textarea
          rows={1}
          aria-label={placeholder}
          placeholder={placeholder}
          value={text}
          autoFocus={autoFocus}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              submit(primary);
            }
          }}
        />
        <div className="chat-composer-buttons">
          {state.kind === "stop" ? (
            <IconButton
              type="button"
              variant="default"
              label="Stop"
              onClick={onStop}
            >
              <Square aria-hidden />
            </IconButton>
          ) : state.kind === "queue-only" ? (
            <Button type="submit" size="sm" disabled={busy}>
              Queue
            </Button>
          ) : (
            <>
              {state.kind === "steer" && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="Queue until this turn ends"
                  disabled={busy}
                  onClick={() => submit(onQueue)}
                >
                  Queue
                </Button>
              )}
              <IconButton
                type="submit"
                variant="default"
                label="Send"
                disabled={busy || (state.kind === "send" && !state.enabled)}
              >
                <ArrowUp aria-hidden />
              </IconButton>
            </>
          )}
        </div>
      </form>
      {(state.kind === "steer" || state.kind === "queue-only") && (
        <p className="chat-hint">{state.hint}</p>
      )}
    </>
  );
}
