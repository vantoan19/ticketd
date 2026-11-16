import { useReminderTime } from "./use-reminder-time";
import { RailRow } from "./RailSection";
import { TicketCommandPicker } from "./TicketCommandPicker";
import type { Project } from "@/lib/api/client";
import type { Plan } from "@/lib/api/plans";
import { TicketCommandContext } from "@/lib/ticket-command-actions";
import { localValue } from "./reminder-time";
import { ReminderDateTime } from "./ReminderDateTime";
import { shortcutLabel, ariaKeyShortcuts } from "@/lib/shortcuts";
import { Bell, CalendarClock } from "lucide-react";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverDescription,
} from "@/components/ui/popover";
import { inboxClient } from "@/lib/api/inbox";
import { useContext, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { ChoiceList } from "@/components/ui/choice-list";
import { FailureAlert } from "@/components/ui/failure-alert";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { useOpenTicket } from "./open-ticket";
import { formatDateTime } from "@/lib/format";
import { reminderSummary } from "@/features/tickets/reminder-summary";
import { reminderPresets } from "./reminder-presets";

/**
 * The ticket's reminder: a trigger in the rail's Attention row ("Remind me"
 * or "Tomorrow, 9:00 AM") or a bell in the property strip, and a popover
 * that leads with presets (Later today, Tomorrow, Next week) and Custom…,
 * which reveals a prefilled date and time named in the person's zone. A
 * scheduled reminder offers Snooze 1 hour and Dismiss.
 */
export function Reminder({
  variant = "rail",
  projects = [],
  plans = [],
}: {
  projects?: Project[];
  plans?: Plan[];
  variant?: "rail" | "strip";
}) {
  const { record: ticket, reference, changed } = useOpenTicket();
  const openCommand = useContext(TicketCommandContext);
  const reminder = useOpenTicket("reminder");
  const due = reminder.value ?? null;
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState("");
  const [occurrence, setOccurrence] = useState("");
  const time = useReminderTime(draft, occurrence);
  const options = time.instants;
  // Reading and changing the reminder fail separately: a failed read names
  // the trigger, a failed change shows under the actions until the next try.
  const loadFailure = reminder.failure;
  const [error, setError] = useState<FailureDescription | null>(null);
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);
  const busy = useRef(false);
  const attempt = useRef<{
    key: string;
    id: string;
    dueAt: string | null;
  } | null>(null);
  async function save(
    key: string,
    makeDue: () => string | null,
    closeAfter = false,
  ) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    const intent = JSON.stringify([reference, key]);
    if (attempt.current?.key !== intent) {
      attempt.current = {
        key: intent,
        id: crypto.randomUUID(),
        dueAt: makeDue(),
      };
    }
    const request = attempt.current;
    try {
      await inboxClient.snooze(reference, request.dueAt, request.id);
      attempt.current = null;
      setError(null);
      // The time was used; nothing typed is left to explain.
      setDraft("");
      setOccurrence("");
      setCustom(false);
      if (closeAfter) setOpen(false);
      await changed();
    } catch (reason) {
      setError(
        describeFailure(
          reason,
          key === "dismiss"
            ? "dismiss the reminder"
            : key === "snooze-hour"
              ? "snooze the reminder"
              : "set the reminder",
        ),
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  const now = new Date();
  const summary = due ? reminderSummary(due) : null;
  const label = summary ?? (loadFailure ? "Reminder unavailable" : "Remind me");
  const name = due
    ? summary === "Reminder due"
      ? "Manage reminder, due"
      : `Manage reminder, scheduled ${summary}`
    : loadFailure
      ? "Manage reminder, unavailable"
      : "Manage reminder";
  function openCustom() {
    setCustom(true);
    // Prefilled: the scheduled time, or tomorrow at 9:00.
    const fallback = reminderPresets(now).find(
      (preset) => preset.key === "tomorrow",
    )!.at;
    setDraft(localValue(due ? new Date(due) : fallback));
    setOccurrence("");
  }
  const presets = reminderPresets(now);
  if (variant === "strip" && openCommand)
    return due ? (
      <TicketCommandPicker
        ticket={ticket}
        projects={projects}
        plans={plans}
        refresh={() => changed()}
        scope="Reminder"
        trigger={
          <RailRow
            icon={<Bell />}
            aria-label={name}
            title={`Remind me (${shortcutLabel("ticket-reminder")})`}
            aria-keyshortcuts={ariaKeyShortcuts("ticket-reminder")}
          >
            {summary}
          </RailRow>
        }
      />
    ) : null;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // A failure belongs to the attempt that made it, not the next visit.
        if (!next) {
          setError(null);
          setCustom(false);
        }
      }}
    >
      <PopoverTrigger asChild>
        {variant === "strip" ? (
          <IconButton
            label={summary ?? label}
            shortcut={shortcutLabel("ticket-reminder")}
            aria-keyshortcuts={ariaKeyShortcuts("ticket-reminder")}
            aria-label={name}
            aria-pressed={due !== null}
          >
            <Bell aria-hidden="true" />
          </IconButton>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            aria-label={name}
            title={`Remind me (${shortcutLabel("ticket-reminder")})`}
            aria-keyshortcuts={ariaKeyShortcuts("ticket-reminder")}
            data-set={due ? "" : undefined}
          >
            <Bell aria-hidden="true" />
            <span className="reminder-label">{label}</span>
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="reminder-popover">
        <PopoverHeader>
          <PopoverTitle>Reminder</PopoverTitle>
          <PopoverDescription>
            {due
              ? summary === "Reminder due"
                ? `Due since ${formatDateTime(due)}.`
                : `Scheduled for ${formatDateTime(due)}.`
              : "Bring this ticket back to your Inbox."}
          </PopoverDescription>
        </PopoverHeader>
        <ChoiceList
          label="Remind me"
          autoFocus={false}
          groups={[
            ...presets.map((preset) => ({
              value: preset.key,
              label: preset.label,
              icon: preset.icon,
              meta: preset.meta,
              disabled: pending,
            })),
            {
              value: "custom",
              label: "Custom…",
              icon: <CalendarClock aria-hidden="true" />,
              disabled: pending,
            },
          ]}
          onSelect={(key) => {
            if (key === "custom") return openCustom();
            const preset = presets.find((item) => item.key === key);
            if (preset) {
              const at = preset.at.toISOString();
              void save(`preset:${at}`, () => at);
            }
          }}
        />
        {custom && (
          <ReminderDateTime
            reference={reference}
            draft={draft}
            occurrence={occurrence}
            pending={pending}
            past={time.past}
            onDraft={(value) => {
              setDraft(value);
              setOccurrence("");
            }}
            onOccurrence={setOccurrence}
          />
        )}
        {(custom || due) && (
          <div className="reminder-actions">
            {due && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() =>
                    void save("snooze-hour", () =>
                      new Date(Date.now() + 3600000).toISOString(),
                    )
                  }
                >
                  Snooze 1 hour
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => void save("dismiss", () => null, true)}
                >
                  Dismiss reminder
                </Button>
              </>
            )}
            {custom && (
              <Button
                size="sm"
                disabled={
                  pending ||
                  time.past ||
                  options.length === 0 ||
                  (options.length > 1 && !occurrence)
                }
                onClick={() => {
                  const selected = time.selectForSubmit();
                  if (!selected) return;
                  void save(`schedule:${selected}`, () => selected);
                }}
              >
                {due ? "Reschedule" : "Set reminder"}
              </Button>
            )}
          </div>
        )}
        {loadFailure && !due && (
          <FailureAlert
            size="compact"
            failure={loadFailure}
            onRetry={reminder.retry}
          />
        )}
        {error && <FailureAlert size="compact" failure={error} />}
      </PopoverContent>
    </Popover>
  );
}
