import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { useStatusLine } from "@/components/ui/use-status-line";
import { client } from "@/lib/api/client";
import { describeFailure } from "@/lib/api/describe-failure";
import { ariaKeyShortcuts, matchesShortcut, shortcutLabel } from "@/lib/shortcuts";
import { onTicketCardReply } from "./activity-composer-request";
import { hasVisibleText } from "./brief-text";
import { useOpenTicket } from "./open-ticket";
import { externalSource } from "./ticket-source";

export function TicketReply({
  active,
  disabled,
}: {
  active: boolean;
  disabled: boolean;
}) {
  const { record: ticket, changed } = useOpenTicket();
  const line = useStatusLine();
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const composing = useRef<HTMLTextAreaElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const writing = useRef(false);
  const intent = useRef<{ brief: string; requestId: string } | null>(null);
  useEffect(() => {
    if (!active || disabled) return;
    return onTicketCardReply(ticket.reference, () => {
      setReplying(true);
      composing.current?.focus();
    });
  }, [active, disabled, ticket.reference]);
  useLayoutEffect(() => {
    if (!active) return;
    if (replying) composing.current?.focus();
    else if (restoreFocus.current) trigger.current?.focus();
    restoreFocus.current = false;
  }, [active, replying]);

  function close() {
    restoreFocus.current = true;
    setReplying(false);
  }

  function submit() {
    if (disabled || writing.current || !hasVisibleText(draft)) return;
    const brief = draft.trim();
    if (intent.current?.brief !== brief)
      intent.current = { brief, requestId: crypto.randomUUID() };
    const { requestId } = intent.current;
    async function post() {
      if (writing.current) return;
      writing.current = true;
      setPending(true);
      try {
        await client.addActivityWithDetails(ticket.reference, brief, null, null, requestId);
        intent.current = null;
        setDraft("");
        close();
        line.show({ message: "Posted the update" });
        await changed();
      } catch (reason) {
        const failure = describeFailure(reason, "post the update");
        line.show({
          tone: "error",
          message: `${failure.title}. ${failure.sentence}`,
          details: failure.details,
          action: { label: "Retry", run: post },
        });
      } finally {
        writing.current = false;
        setPending(false);
      }
    }
    void post();
  }

  if (!replying)
    return (
      <div className="ticket-decision-row">
        <Button
          ref={trigger}
          type="button"
          variant="outline"
          size="compact"
          onClick={() => setReplying(true)}
          disabled={disabled}
          aria-keyshortcuts={ariaKeyShortcuts("ticket-update")}
        >
          Reply <Kbd aria-hidden="true">{shortcutLabel("ticket-update")}</Kbd>
        </Button>
      </div>
    );
  const owner = externalSource(ticket);
  return (
    <form
      className="ticket-reply"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (matchesShortcut(event, "update-post")) {
          event.preventDefault();
          submit();
        } else if (event.key === "Escape" && !pending) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <Textarea
        ref={composing}
        aria-label="Reply"
        placeholder="Write a reply…"
        rows={3}
        value={draft}
        readOnly={pending}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="ticket-decision-row">
        <Button size="compact" type="submit" disabled={disabled || !hasVisibleText(draft)} busy={pending}>
          Post update
        </Button>
        <Button variant="ghost" size="compact" type="button" disabled={pending} onClick={close}>
          Cancel
        </Button>
        {owner && <span className="ticket-decision-byline">Not posted to {owner.provider_name}</span>}
      </div>
    </form>
  );
}
