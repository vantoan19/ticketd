import { useEffect, useState } from "react";
import { client, type Project, type Ticket } from "@/lib/api/client";
import { invoke } from "@/lib/api/bridge-failure";
import { failureText } from "@/lib/api/describe-failure";
import { editingBlockedReason, useWorkspaceState } from "@/lib/workspace-state";
import { useStatusLine } from "@/components/ui/use-status-line";
import {
  externalSource,
  ticketStatusChoices,
} from "@/features/tickets/ticket-source";
import { reminderPresets } from "@/features/tickets/reminder-presets";
import type { TicketCommandScope } from "@/lib/ticket-command-actions";

type Option = { value: string; label: string; selected?: boolean };
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
  refresh: () => Promise<void>;
}) {
  const [target, setTarget] = useState<Ticket | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [due, setDue] = useState<string | null>(null);
  const [reminderLoaded, setReminderLoaded] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
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
    void invoke("reminder", { reference })
      .then((value) => {
        if (value !== null && typeof value !== "string")
          throw new Error("Invalid reminder");
        if (active) {
          setDue(value);
          setReminderLoaded(reference);
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          const message = failureText(reason, "load reminder");
          setError(message);
          line.show({ message, tone: "error" });
        }
      });
    return () => {
      active = false;
    };
  }, [open, reference, scope, line]);
  const ticket =
    initialTicket ?? (target?.reference === reference ? target : null);
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
        ...projects.map((p) => ({
          value: p.id,
          label: p.name,
          selected: p.id === ticket.project_id,
        })),
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
  async function apply(value: string, confirmed = false, customAt?: string) {
    if (
      !ticket ||
      blocked ||
      pending ||
      !scope ||
      (scope === "Reminder" && reminderLoaded !== ticket.reference)
    )
      return;
    if (
      scope === "Status" &&
      ticket.status === value &&
      (value !== "Duplicate" || externalSource(ticket))
    ) {
      close();
      return;
    }
    if (scope === "Status" && value === "Duplicate") {
      close();
      setDuplicate(true);
      return;
    }
    if (
      scope === "Status" &&
      ticket.status === "Duplicate" &&
      ticket.duplicate_of &&
      !confirmed
    ) {
      close();
      setLeaving(value);
      return;
    }
    const reference = ticket.reference;
    let forward: () => Promise<unknown>;
    let undo: () => Promise<unknown>;
    let message: string;
    switch (scope) {
      case "Status":
        forward = () => client.changeTicket(reference, { status: value });
        undo = () => client.changeTicket(reference, { status: ticket.status });
        message = `Moved ${reference} to ${value}`;
        break;
      case "Project":
        forward = () =>
          client.changeTicket(reference, { project_id: value || null });
        undo = () =>
          client.changeTicket(reference, { project_id: ticket.project_id });
        message = `Moved ${reference} to ${projects.find((p) => p.id === value)?.name ?? "No project"}`;
        break;
      case "Plan":
        forward = () => client.setPlan(reference, value || null);
        undo = () => client.setPlan(reference, ticket.plan_id);
        message = value
          ? `Added ${reference} to ${plans.find((p) => p.id === value)?.name ?? value}`
          : `Removed ${reference} from its Plan`;
        break;
      case "Tags": {
        const removing = ticket.tags.includes(value);
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
        const requestId = crypto.randomUUID();
        forward = () => invoke("set_reminder", { reference, dueAt, requestId });
        undo = () =>
          invoke("set_reminder", {
            reference,
            dueAt: due,
            requestId: crypto.randomUUID(),
          });
        message = dueAt
          ? `Set a reminder for ${reference}`
          : `Dismissed reminder for ${reference}`;
        break;
      }
    }
    setPending(true);
    try {
      await forward();
      close();
      line.show({
        message,
        ...(scope !== "Status" || ticket.status !== "Duplicate"
          ? {
              undo: async () => {
                await undo();
                await refresh();
              },
            }
          : {}),
      });
      await refresh().catch((reason: unknown) =>
        line.show({
          message: `Saved, not refreshed. ${failureText(reason, "refresh the ticket")}`,
          tone: "error",
          action: { label: "Retry", run: refresh },
        }),
      );
    } catch (reason) {
      const message = failureText(reason, `change ${scope.toLowerCase()}`);
      setError(message);
      line.show({ message, tone: "error" });
    } finally {
      setPending(false);
    }
  }
  return {
    ticket,
    options,
    apply,
    blocked,
    pending: pending || (scope === "Reminder" && reminderLoaded !== reference),
    due,
    error,
    duplicate,
    setDuplicate,
    leaving,
    setLeaving,
  };
}
