import { externalDuplicateTarget } from "./ticket-source";
import type { Ticket } from "@/lib/api/client";

export type RowScope = {
  /** Show the Plan when the view spans several Plans. */
  showPlan: boolean;
  /** Show the project when the view spans several projects. */
  showProject: boolean;
  plans: { id: string; name: string }[];
  projects: { id: string; name: string }[];
};

export type Readiness =
  | { kind: "ready" }
  | { kind: "blocked"; by: string; more: number; trashed?: boolean }
  | { kind: "status"; status: string };

/** Ready and Blocked apply only to Todo; every other status shows its word. */
export function readiness(ticket: Ticket): Readiness {
  if (ticket.status !== "Todo" || !ticket.availability)
    return { kind: "status", status: ticket.status };
  if (ticket.availability === "Ready") return { kind: "ready" };
  const open = ticket.prerequisites.filter((item) => item.unresolved);
  const [first] = open;
  if (!first) return { kind: "status", status: ticket.status };
  return {
    kind: "blocked",
    by: first.reference,
    more: open.length - 1,
    ...(first.trashed ? { trashed: true } : {}),
  };
}

export function readinessLabel(value: Readiness) {
  if (value.kind === "ready") return "Ready";
  if (value.kind === "status") return value.status;
  return `Blocked by ${value.by}${value.trashed ? " (in Trash)" : ""}${value.more > 0 ? ` and ${value.more} more` : ""}`;
}

/** Visible form: the count comes right after the first blocker so truncation cannot hide it. */
export function readinessShortLabel(value: Readiness) {
  if (value.kind !== "blocked" || value.more === 0)
    return readinessLabel(value);
  return `Blocked by ${value.by}${value.trashed ? " (in Trash)" : ""} +${value.more}`;
}

export type RowContextKind = "duplicate" | "subticket" | "plan" | "project";

/** At most one context item: duplicate, parent, Plan, then project. */
export function rowContextItem(
  ticket: Ticket,
  scope: RowScope,
): { kind: RowContextKind; label: string } | null {
  if (ticket.duplicate_of)
    return { kind: "duplicate", label: `Duplicate of ${ticket.duplicate_of}` };
  // An externally closed duplicate names the source's canonical issue, or says it is unknown.
  const target = externalDuplicateTarget(ticket);
  if (target)
    return {
      kind: "duplicate",
      label:
        target.kind === "external"
          ? `Duplicate of ${target.ticket ?? target.display}`
          : "Duplicate · target unknown",
    };
  if (ticket.parent)
    return {
      kind: "subticket",
      label: `Subticket of ${ticket.parent.reference}${ticket.parent.trashed ? " (trashed)" : ""}`,
    };
  const plan =
    scope.showPlan && ticket.plan_id
      ? scope.plans.find((item) => item.id === ticket.plan_id)
      : undefined;
  if (plan) return { kind: "plan", label: plan.name };
  const project =
    scope.showProject && ticket.project_id
      ? scope.projects.find((item) => item.id === ticket.project_id)
      : undefined;
  return project ? { kind: "project", label: project.name } : null;
}

export function rowContext(ticket: Ticket, scope: RowScope): string | null {
  return rowContextItem(ticket, scope)?.label ?? null;
}
