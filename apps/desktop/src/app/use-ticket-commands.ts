import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { client, type Project, type Ticket } from "@/lib/api/client";
import { inboxClient } from "@/lib/api/inbox";
import { failureText } from "@/lib/api/describe-failure";
import {
  archivedProjectHint,
  archivedProjectMatch,
  projectAssignmentChoices,
} from "@/features/projects/project-assignment";
import { editingBlockedReason, useWorkspaceState } from "@/lib/workspace-state";
import { useStatusLine } from "@/components/ui/use-status-line";
import {
  externalSource,
  ticketStatusChoices,
} from "@/features/tickets/ticket-source";
import { reminderPresets } from "@/features/tickets/reminder-presets";
import type { TicketCommandScope } from "@/lib/ticket-command-actions";

type Option = {
  value: string;
  label: string;
  selected?: boolean;
  group?: string;
};
export function useTicketCommands({
  reference,
  initialTicket,
  open,
  scope,
  query,
  projects,
  plans,
  close,
  refresh,
}: {
  initialTicket: Ticket | null;
  reference: string | null;
  open: boolean;
  scope: TicketCommandScope | null;
  query: string;
  projects: Project[];
  plans: { id: string; name: string; archived: boolean }[];
  close: () => void;
  /** The write report, with the Ticket the write returned. */
  refresh: (returned?: Ticket) => Promise<void>;
}) {
  const [target, setTarget] = useState<Ticket | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [due, setDue] = useState<string | null>(null);
  const [reminderLoaded, setReminderLoaded] = useState<string | null>(null);
  const [reminderReads, setReminderReads] = useState(0);
  const reminderAttempt = useRef<{
    key: string;
    requestId: string;
    dueAt: string | null;
    previousDue: string | null;
  } | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState<(() => void) | null>(null);
  const opening = useMemo(
    () => ({ open, reference, scope }),
    [open, reference, scope],
  );
  const currentOpening = useRef<typeof opening | null>(null);
  useLayoutEffect(() => {
    currentOpening.current = opening;
    return () => {
      currentOpening.current = null;
    };
  }, [opening]);
  const [pendingOpening, setPendingOpening] = useState<typeof opening | null>(
    null,
  );
  const pending = pendingOpening === opening;
  const [duplicate, setDuplicate] = useState(false);
  const [leaving, setLeaving] = useState<string | null>(null);
  const blocked =
    editingBlockedReason(useWorkspaceState()) !== null || !!target?.trashed;
  const line = useStatusLine();
  useEffect(() => {
    if (!open || !reference) return;
    let active = true;
    void client
      .showTicket(reference)
      .then((value) => {
        if (active) {
          setTarget(value);
          setError("");
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          const message = failureText(reason, "load ticket actions");
          setError(message);
          line.show({ message, tone: "error" });
        }
      });
    return () => {
      active = false;
    };
  }, [open, reference, line]);
  useEffect(() => {
    if (!open || scope !== "Tags") return;
    let active = true;
    void client
      .searchTags(query)
      .then((value) => {
        if (active) setTags(value);
      })
      .catch((reason: unknown) => {
        if (active) {
          const message = failureText(reason, "load tag suggestions");
          setError(message);
          line.show({ message, tone: "error" });
        }
      });
    return () => {
      active = false;
    };
  }, [open, scope, query, line]);
  useEffect(() => {
    if (!open || !reference || scope !== "Reminder") return;
    let active = true;
    void inboxClient
      .reminder(reference)
      .then((value) => {
        if (active) {
          setDue(value);
          setReminderLoaded(reference);
          setRetry(null);
          setError("");
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          const message = failureText(reason, "load reminder");
          setError(message);
          setRetry(() => () => setReminderReads((value) => value + 1));
          line.show({ message, tone: "error" });
        }
      });
    return () => {
      active = false;
    };
  }, [open, reference, scope, line, reminderReads]);
  // The Ticket a flow that outlives the palette (the duplicate review) was
  // started on. The palette's own copy goes with it, and the list may not
  // hold the Ticket, so the flow keeps the one it began with.
  const [flowTicket, setFlowTicket] = useState<Ticket | null>(null);
  const flowing = duplicate || leaving !== null;
  const ticket =
    (flowing ? flowTicket : null) ??
    initialTicket ??
    (target?.reference === reference ? target : null);
  const presets = reminderPresets(new Date());
  let options: Option[] = [];
  if (ticket) {
    if (scope === "Status")
      options = ticketStatusChoices(ticket).map((value) => ({
        value,
        label:
          value === "Duplicate"
            ? ticket.status === "Duplicate"
              ? "Change canonical ticket…"
              : "Mark as duplicate…"
            : value,
        selected: ticket.status === value,
      }));
    if (scope === "Project")
      options = [
        ...projectAssignmentChoices(projects, ticket.project_id).map(
          (option) => ({
            ...option,
            selected: option.value === ticket.project_id,
          }),
        ),
        {
          value: "",
          label: "No project",
          selected: ticket.project_id === null,
        },
      ];
    if (scope === "Plan")
      options = [
        ...plans
          .filter((p) => !p.archived)
          .map((p) => ({
            value: p.id,
            label: p.name,
            selected: p.id === ticket.plan_id,
          })),
        { value: "", label: "No Plan", selected: ticket.plan_id === null },
      ];
    if (scope === "Tags")
      options = [...new Set([...tags, ...ticket.tags])].map((value) => ({
        value,
        label: value,
        selected: ticket.tags.includes(value),
      }));
    if (scope === "Reminder")
      options = [
        ...presets.map((p) => ({ value: p.key, label: p.label })),
        { value: "custom", label: "Custom…" },
        ...(due ? [{ value: "dismiss", label: "Dismiss reminder" }] : []),
      ];
  }
  options = options.filter((option) =>
    option.label.toLowerCase().includes(query.trim().toLowerCase()),
  );
  if (
    ticket &&
    scope === "Tags" &&
    query.trim() &&
    !options.some(
      (option) => option.value.toLowerCase() === query.trim().toLowerCase(),
    )
  )
    options.push({ value: query.trim(), label: `Create “${query.trim()}”` });
  if (scope === "Project" && query.trim()) {
    const needle = query.trim().toLowerCase();
    options = options.filter((option) =>
      option.label.toLowerCase().includes(needle),
    );
  }
  const archivedMatch =
    scope === "Project" && options.length === 0
      ? archivedProjectMatch(projects, query)
      : undefined;
  async function apply(
    value: string,
    confirmed = false,
    customAt?: string,
    read?: Ticket,
  ) {
    // The copy shown may be older than the Workspace; `read` is one just made.
    const subject = read ?? ticket;
    if (
      !subject ||
      currentOpening.current !== opening ||
      blocked ||
      pending ||
      !scope ||
      (scope === "Reminder" && reminderLoaded !== subject.reference)
    )
      return;
    if (
      (scope === "Status" &&
        subject.status === value &&
        (value !== "Duplicate" || externalSource(subject))) ||
      (scope === "Project" && value === (subject.project_id ?? ""))
    ) {
      // Only a read made now says it is already set (the ADR's check before a
      // write); a copy from before a change elsewhere would close without writing.
      if (!read) {
        setPendingOpening(opening);
        let current: Ticket;
        try {
          current = await client.showTicket(subject.reference);
        } catch (reason) {
          if (currentOpening.current !== opening) return;
          const message = failureText(
            reason,
            `check the ${scope.toLowerCase()}`,
          );
          setError(message);
          line.show({ message, tone: "error" });
          return;
        } finally {
          setPendingOpening((pending) =>
            pending === opening ? null : pending,
          );
        }
        return apply(value, confirmed, customAt, current);
      }
      close();
      return;
    }

    if (scope === "Status" && value === "Duplicate") {
      setFlowTicket(subject);
      close();
      setDuplicate(true);
      return;
    }
    if (
      scope === "Status" &&
      subject.status === "Duplicate" &&
      subject.duplicate_of &&
      !confirmed
    ) {
      setFlowTicket(subject);
      close();
      setLeaving(value);
      return;
    }
    const reference = subject.reference;
    let forward: () => Promise<Ticket | void>;
    let undo: () => Promise<Ticket | void>;
    let message: string;
    let failureAction = `change ${scope.toLowerCase()}`;
    switch (scope) {
      case "Status":
        forward = () => client.changeTicket(reference, { status: value });
        undo = () => client.changeTicket(reference, { status: subject.status });
        message = `Moved ${reference} to ${value}`;
        break;
      case "Project": {
        const destination =
          projects.find((project) => project.id === value)?.name ??
          "No project";
        failureAction = `move ${reference} to ${destination}`;
        forward = () =>
          client.changeTicket(reference, { project_id: value || null });
        undo = () =>
          client.changeTicket(reference, { project_id: subject.project_id });
        message = `Moved ${reference} to ${destination}`;
        break;
      }
      case "Plan":
        forward = () => client.setPlan(reference, value || null);
        undo = () => client.setPlan(reference, subject.plan_id);
        message = value
          ? `Added ${reference} to ${plans.find((p) => p.id === value)?.name ?? value}`
          : `Removed ${reference} from its Plan`;
        break;
      case "Tags": {
        const removing = subject.tags.includes(value);
        forward = () =>
          client.changeTag(
            removing ? "remove_tag" : "add_tag",
            reference,
            value,
          );
        undo = () =>
          client.changeTag(
            removing ? "add_tag" : "remove_tag",
            reference,
            value,
          );
        message = `${removing ? "Removed" : "Added"} ${value} ${removing ? "from" : "to"} ${reference}`;
        break;
      }
      case "Reminder": {
        const dueAt =
          customAt ??
          presets.find((p) => p.key === value)?.at.toISOString() ??
          null;
        const key = JSON.stringify([reference, value, customAt ?? null]);
        if (reminderAttempt.current?.key !== key)
          reminderAttempt.current = {
            key,
            requestId: crypto.randomUUID(),
            dueAt,
            previousDue: due,
          };
        const attempt = reminderAttempt.current;
        const undoRequestId = crypto.randomUUID();
        forward = async () => {
          await inboxClient.snooze(reference, attempt.dueAt, attempt.requestId);
          if (reminderAttempt.current === attempt)
            reminderAttempt.current = null;
        };
        undo = () =>
          inboxClient.snooze(reference, attempt.previousDue, undoRequestId);
        message = dueAt
          ? `Set a reminder for ${reference}`
          : `Dismissed reminder for ${reference}`;
        break;
      }
    }
    setPendingOpening(opening);
    try {
      const written = await forward();
      if (currentOpening.current === opening) {
        setRetry(null);
        setError("");
        close();
      }
      line.show({
        message,
        ...((scope !== "Status" || subject.status !== "Duplicate") &&
        (scope !== "Project" ||
          !projects.some(
            (project) => project.id === subject.project_id && project.archived,
          ))
          ? {
              undo: async () => {
                await refresh((await undo()) ?? undefined);
              },
            }
          : {}),
      });
      await refresh(written ?? undefined).catch((reason: unknown) =>
        line.show({
          message: `Saved, not refreshed. ${failureText(reason, "refresh the ticket")}`,
          tone: "error",
          action: { label: "Retry", run: () => refresh(written ?? undefined) },
        }),
      );
    } catch (reason) {
      const message = failureText(reason, failureAction);
      if (currentOpening.current === opening) {
        setError(message);
        if (scope === "Reminder")
          setRetry(() => () => {
            void apply(value, confirmed, customAt);
          });
      }
      line.show({ message, tone: "error" });
    } finally {
      setPendingOpening((pending) => (pending === opening ? null : pending));
    }
  }
  return {
    ticket,
    options,
    projectHint: archivedMatch ? archivedProjectHint(archivedMatch) : undefined,
    apply,
    blocked,
    pending: pending || (scope === "Reminder" && reminderLoaded !== reference),
    due,
    error,
    retry,
    duplicate,
    setDuplicate,
    leaving,
    setLeaving,
  };
}
