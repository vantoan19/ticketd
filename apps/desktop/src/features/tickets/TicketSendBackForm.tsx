import type { Ref } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import {
  ariaKeyShortcuts,
  matchesShortcut,
  shortcutLabel,
} from "@/lib/shortcuts";

export function TicketSendBackForm({
  field,
  brief,
  agent,
  sourceName,
  pending,
  disabled,
  onChange,
  onCancel,
  onSubmit,
}: {
  field: Ref<HTMLTextAreaElement>;
  brief: string;
  agent: string;
  sourceName: string | undefined;
  pending: boolean;
  disabled: boolean;
  onChange: (brief: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <form
      className="ticket-review-form"
      aria-label="Send work back"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (matchesShortcut(event, "ticket-review-send-back-submit")) {
          event.preventDefault();
          event.stopPropagation();
          onSubmit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (!pending) onCancel();
        }
      }}
    >
      <Textarea
        ref={field}
        rows={3}
        aria-label="What needs to change?"
        placeholder={`What needs to change? ${agent} reads this next.`}
        value={brief}
        readOnly={pending}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="ticket-decision-row">
        <Button
          type="submit"
          size="compact"
          disabled={disabled || !brief.trim()}
          busy={pending}
          aria-keyshortcuts={ariaKeyShortcuts("ticket-review-send-back-submit")}
        >
          Send back
          <Kbd aria-hidden="true">
            {shortcutLabel("ticket-review-send-back-submit")}
          </Kbd>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="compact"
          disabled={pending}
          onClick={onCancel}
          aria-keyshortcuts="Escape"
        >
          Cancel <Kbd aria-hidden="true">Esc</Kbd>
        </Button>
        <span className="ticket-decision-byline">
          Moves the ticket to In progress
        </span>
      </div>
      {sourceName && (
        <p className="ticket-decision-byline">Not posted to {sourceName}</p>
      )}
    </form>
  );
}
