import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { useStatusLine } from "@/components/ui/use-status-line";
import { client } from "@/lib/api/client";
import { describeFailure } from "@/lib/api/describe-failure";
import { useDraftRecovery } from "@/lib/draft-recovery-context";
import {
  ariaKeyShortcuts,
  matchesShortcut,
  shortcutLabel,
} from "@/lib/shortcuts";
import { onTicketCardReply } from "./activity-composer-request";
import { hasVisibleText } from "./brief-text";
import { useOpenTicket } from "./open-ticket";
import { externalSource } from "./ticket-source";
import {
  keepTicketUpdateDraft,
  readTicketUpdateDraft,
  type TicketUpdateDraft,
} from "./ticket-update-draft";

const emptyDraft: TicketUpdateDraft = { brief: "", requestId: null };

function sameDraft(left: TicketUpdateDraft | null, right: TicketUpdateDraft) {
  return left?.requestId === right.requestId && left.brief === right.brief;
}

export function TicketReply({
  active,
  disabled,
}: {
  active: boolean;
  disabled: boolean;
}) {
  const { record: ticket, changed } = useOpenTicket();
  const line = useStatusLine();
  const recovery = useDraftRecovery();
  const [replying, setReplying] = useState(false);
  const [draft, setDraftValue] = useState(emptyDraft);
  const currentDraft = useRef(draft);
  const [pending, setPending] = useState(false);
  const composing = useRef<HTMLTextAreaElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const writing = useRef(false);
  const setDraft = useCallback((next: TicketUpdateDraft) => {
    currentDraft.current = next;
    setDraftValue(next);
  }, []);
  const open = useCallback(() => {
    if (!replying)
      setDraft(
        readTicketUpdateDraft(recovery, ticket.id, "reply") ?? emptyDraft,
      );
    setReplying(true);
    composing.current?.focus();
  }, [recovery, replying, setDraft, ticket.id]);
  useEffect(() => {
    if (!active || disabled) return;
    return onTicketCardReply(ticket.reference, open);
  }, [active, disabled, open, ticket.reference]);
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

  function edit(brief: string) {
    if (writing.current) return;
    const next = {
      brief,
      requestId: brief.trim() === draft.brief.trim() ? draft.requestId : null,
    };
    setDraft(next);
    void keepTicketUpdateDraft(
      recovery,
      ticket.id,
      "reply",
      brief ? next : null,
    ).catch(() => {});
  }

  function submit() {
    if (disabled || writing.current || !hasVisibleText(draft.brief)) return;
    const requestId = draft.requestId ?? crypto.randomUUID();
    const submission = { brief: draft.brief, requestId };
    setDraft(submission);
    let attempted = false;
    async function post() {
      if (writing.current) return;
      // An unsent reply can be superseded by editing the draft. Once a write
      // was attempted, Retry must replay the same submission and request ID.
      if (!attempted && !sameDraft(currentDraft.current, submission)) return;
      writing.current = true;
      setPending(true);
      try {
        if (!attempted) {
          const retained = keepTicketUpdateDraft(
            recovery,
            ticket.id,
            "reply",
            submission,
          );
          if (recovery.active) {
            // The recovery store retries queued writes when explicitly flushed.
            void retained.catch(() => {});
            await recovery.flush();
          } else {
            await retained;
          }
        }
        attempted = true;
        await client.addActivityWithDetails(
          ticket.reference,
          submission.brief.trim(),
          null,
          null,
          requestId,
        );
        if (
          sameDraft(currentDraft.current, submission) &&
          sameDraft(
            readTicketUpdateDraft(recovery, ticket.id, "reply"),
            submission,
          )
        ) {
          void keepTicketUpdateDraft(recovery, ticket.id, "reply", null).catch(
            () => {},
          );
          setDraft(emptyDraft);
          close();
        }
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
          onClick={open}
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
        value={draft.brief}
        readOnly={pending}
        onChange={(event) => edit(event.target.value)}
      />
      <div className="ticket-decision-row">
        <Button
          size="compact"
          type="submit"
          disabled={disabled || !hasVisibleText(draft.brief)}
          busy={pending}
        >
          Post update
        </Button>
        <Button
          variant="ghost"
          size="compact"
          type="button"
          disabled={pending}
          onClick={close}
        >
          Cancel
        </Button>
        {owner && (
          <span className="ticket-decision-byline">
            Not posted to {owner.provider_name}
          </span>
        )}
      </div>
    </form>
  );
}
