import {
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { Bell, Folder, Layers, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { Kbd } from "@/components/ui/kbd";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { StatusDot } from "@/components/ui/status-dot";
import { CrossfadeText } from "@/components/ui/motion";
import { ofTotal } from "@/lib/format";
import { ariaKeyShortcuts, shortcutLabel } from "@/lib/shortcuts";
import {
  ticketCommandActions,
  type TicketCommandScope,
} from "@/lib/ticket-command-actions";
import type { Project, Ticket } from "@/lib/api/client";
import type { Plan } from "@/lib/api/plans";
import { RailRow } from "./RailSection";
import { StatusIcon } from "./StatusIcon";
import { TicketCommandPicker } from "./TicketCommandPicker";
import type { AddableKind } from "./linked-work";
import { useOpenTicket } from "./open-ticket";
import { reminderSummary } from "./reminder-summary";
import type { LinkedWorkState } from "./useLinkedWork";

function addBlockerKey(event: KeyboardEvent, addBlocker: () => void) {
  if (
    event.key.toLowerCase() !== "b" ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.repeat
  )
    return;
  event.preventDefault();
  event.stopPropagation();
  addBlocker();
}

function orderBlockers(work: LinkedWorkState) {
  const prerequisites = work.current?.links?.prerequisites;
  if (!prerequisites)
    return [...work.ticket.prerequisites].sort(
      (a, b) => Number(b.unresolved) - Number(a.unresolved),
    );
  const rows: Ticket["prerequisites"] = work.rows.filter(
    (row) => row.kind === "blocked_by",
  );
  if (prerequisites.next_offset !== null) {
    // The ticket record already contains all blockers; the paged links hold
    // the newer values and optimistic removals for the rows they have read.
    const loaded = new Set(prerequisites.items.map((row) => row.reference));
    rows.push(
      ...work.ticket.prerequisites.filter((row) => !loaded.has(row.reference)),
    );
  }
  return rows.sort((a, b) => Number(b.unresolved) - Number(a.unresolved));
}

/** The same blocker details and action can be opened from the context line or the card. */
export function TicketBlockersPopover({
  work,
  select,
  trigger,
}: {
  work: LinkedWorkState;
  select: (reference: string) => void;
  trigger: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const rows = orderBlockers(work);
  const unresolved = rows.filter((row) => row.unresolved).length;
  const readOnly = work.ticket.trashed;
  const addBlocker = () => {
    setOpen(false);
    work.openLink("blocked_by");
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label="Blockers"
        className="ticket-blockers-popover"
        onKeyDown={(event) => {
          if (!readOnly) addBlockerKey(event, addBlocker);
        }}
      >
        <ul>
          {rows.map((row) => (
            <li key={row.reference}>
              <RailRow
                icon={<StatusIcon status={row.status} decorative />}
                onClick={() => {
                  setOpen(false);
                  select(row.reference);
                }}
              >
                <span>
                  {row.reference} {row.title}
                </span>
                <span className="text-muted-foreground">
                  {" "}
                  · {row.status}
                  {row.trashed && " · In Trash"}
                </span>
              </RailRow>
            </li>
          ))}
        </ul>
        <div className="ticket-blockers-footer text-muted-foreground">
          <span>{ofTotal(unresolved, rows.length)} still open</span>
          {!readOnly && (
            <>
              <span aria-hidden="true">·</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={addBlocker}
                aria-keyshortcuts="B"
              >
                Add a blocker <Kbd aria-hidden="true">B</Kbd>
              </Button>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** One anchored entry point for menus sharing the same ticket property choices. */
function PropertyMenu({
  picker,
  trigger,
  open,
  onOpenChange,
  children,
  label,
  onKeyDown,
}: {
  picker: Pick<
    ComponentProps<typeof TicketCommandPicker>,
    "ticket" | "projects" | "plans" | "refresh"
  >;
  trigger: ReactElement;
  open: TicketCommandScope | null;
  onOpenChange: (scope: TicketCommandScope | null) => void;
  children: ReactNode;
  label: string;
  onKeyDown?: (event: KeyboardEvent) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <TicketCommandPicker
      {...picker}
      scope={open ?? "Project"}
      open={open !== null}
      onOpenChange={(visible) => {
        if (!visible) onOpenChange(null);
      }}
      anchorOnly
      trigger={
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
          <DropdownMenuContent
            aria-label={label}
            align="start"
            onCloseAutoFocus={(event) => {
              if (open) event.preventDefault();
            }}
            onKeyDown={(event) => {
              onKeyDown?.(event);
              if (event.defaultPrevented) setMenuOpen(false);
            }}
          >
            {children}
          </DropdownMenuContent>
        </DropdownMenu>
      }
    />
  );
}

export function TicketContextLine({
  projects,
  plans,
  work,
  select,
  onOpenSubtickets,
}: {
  projects: Project[];
  plans: Plan[];
  work: LinkedWorkState;
  select: (reference: string) => void;
  onOpenSubtickets: () => void;
}) {
  const { record: ticket, changed } = useOpenTicket();
  const reminder = useOpenTicket("reminder");
  const [addProperty, setAddProperty] = useState<TicketCommandScope | null>(
    null,
  );
  const [assignment, setAssignment] = useState<TicketCommandScope | null>(null);
  const readOnly = ticket.trashed;
  const picker = { ticket, projects, plans, refresh: changed };
  const project = projects.find(({ id }) => id === ticket.project_id);
  const plan = plans.find(({ id }) => id === ticket.plan_id);
  const projectName = project
    ? `${project.name}${project.archived ? " (archived)" : ""}`
    : ticket.project_id;
  const planName = plan
    ? `${plan.name}${plan.archived ? " (archived)" : ""}`
    : ticket.plan_id;
  const assignmentName = [projectName, planName].filter(Boolean).join(" / ");
  const unresolved = orderBlockers(work).filter((row) => row.unresolved);
  const firstBlocker = unresolved[0];
  const progress = work.current?.links?.children_progress;
  const chips: ReactElement[] = [];

  chips.push(
    <TicketCommandPicker
      key="status"
      {...picker}
      scope="Status"
      trigger={
        <RailRow
          icon={<StatusIcon status={ticket.status} decorative />}
          aria-label={`Status: ${ticket.status}`}
          aria-keyshortcuts={ariaKeyShortcuts("ticket-status")}
          disabled={readOnly}
          readOnly={readOnly}
          title={`Change status (${shortcutLabel("ticket-status")})`}
        >
          <CrossfadeText>{ticket.status}</CrossfadeText>
        </RailRow>
      }
    />,
  );
  if (assignmentName) {
    const scope = projectName ? "Project" : "Plan";
    const trigger = (
      <RailRow
        icon={
          projectName ? (
            <Folder aria-hidden="true" />
          ) : (
            <Layers aria-hidden="true" />
          )
        }
        aria-label={`${projectName && planName ? "Project / Plan" : scope}: ${assignmentName}`}
        aria-keyshortcuts={
          projectName && planName
            ? "P L"
            : shortcutLabel(
                scope === "Project" ? "ticket-project" : "ticket-plan",
              )
        }
        disabled={readOnly}
        readOnly={readOnly}
      >
        <CrossfadeText>{assignmentName}</CrossfadeText>
      </RailRow>
    );
    chips.push(
      projectName && planName ? (
        <PropertyMenu
          key="assignment"
          picker={picker}
          trigger={trigger}
          label="Project and Plan"
          open={assignment}
          onOpenChange={setAssignment}
        >
          <DropdownMenuItem onSelect={() => setAssignment("Project")}>
            Project
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAssignment("Plan")}>
            Plan <Kbd aria-hidden="true">L</Kbd>
          </DropdownMenuItem>
        </PropertyMenu>
      ) : (
        <TicketCommandPicker
          key="assignment"
          {...picker}
          scope={scope}
          trigger={trigger}
        />
      ),
    );
  }
  if (firstBlocker) {
    chips.push(
      <TicketBlockersPopover
        key="blockers"
        work={work}
        select={select}
        trigger={
          <RailRow icon={<StatusDot tone="blocked" />}>
            Blocked by {firstBlocker.reference}
            {unresolved.length > 1 && ` +${unresolved.length - 1}`}
          </RailRow>
        }
      />,
    );
  }
  if (progress?.total) {
    chips.push(
      <RailRow
        key="subtickets"
        onClick={onOpenSubtickets}
        icon={
          <svg
            className="ticket-subtickets-ring"
            viewBox="0 0 16 16"
            aria-hidden="true"
          >
            <circle
              cx="8"
              cy="8"
              r="6"
              stroke="currentColor"
              strokeOpacity="0.2"
            />
            <circle
              cx="8"
              cy="8"
              r="6"
              stroke="currentColor"
              pathLength="1"
              strokeDasharray={`${progress.done / progress.total} 1`}
              transform="rotate(-90 8 8)"
            />
          </svg>
        }
      >
        {ofTotal(progress.done, progress.total)} subtickets
      </RailRow>,
    );
  }
  if (ticket.tags.length > 0) {
    chips.push(
      <TicketCommandPicker
        key="tags"
        {...picker}
        scope="Tags"
        trigger={
          <RailRow
            aria-label={`Tags: ${ticket.tags.join(", ")}`}
            aria-keyshortcuts={ariaKeyShortcuts("ticket-tags")}
            disabled={readOnly}
            readOnly={readOnly}
            title={`Edit tags (${shortcutLabel("ticket-tags")})`}
          >
            <span className="ticket-context-tags">
              {ticket.tags.slice(0, 2).map((tag) => (
                <Badge key={tag}>{tag}</Badge>
              ))}
              {ticket.tags.length > 2 && (
                <span className="text-muted-foreground">
                  +{ticket.tags.length - 2}
                </span>
              )}
            </span>
          </RailRow>
        }
      />,
    );
  }
  if (reminder.value && !readOnly) {
    const summary = reminderSummary(reminder.value);
    chips.push(
      <TicketCommandPicker
        key="reminder"
        {...picker}
        scope="Reminder"
        trigger={
          <RailRow
            icon={<Bell aria-hidden="true" />}
            aria-label={
              summary === "Reminder due"
                ? "Manage reminder, due"
                : `Manage reminder, scheduled ${summary}`
            }
            aria-keyshortcuts={ariaKeyShortcuts("ticket-reminder")}
            title={`Remind me (${shortcutLabel("ticket-reminder")})`}
          >
            {summary}
          </RailRow>
        }
      />,
    );
  }
  const missing: TicketCommandScope[] = [];
  if (!projectName) missing.push("Project");
  if (!planName) missing.push("Plan");
  if (ticket.tags.length === 0) missing.push("Tags");
  if (!reminder.value) missing.push("Reminder");
  const linkActions: { kind: AddableKind; label: string }[] = [
    { kind: "blocked_by", label: "Blocked by…" },
    ...(!ticket.parent && !work.current?.links?.parent
      ? [{ kind: "parent" as const, label: "Parent…" }]
      : []),
    { kind: "subticket", label: "Subticket…" },
    { kind: "related", label: "Link a ticket…" },
  ];
  const last = chips.pop();
  return (
    <div
      className="ticket-context-line"
      role="group"
      aria-label="Ticket properties"
    >
      {chips}
      <span className="ticket-context-tail">
        {last}
        {!readOnly && (
          <PropertyMenu
            picker={picker}
            trigger={
              <IconButton label="Add ticket property" size="icon-compact">
                <Plus />
              </IconButton>
            }
            open={addProperty}
            onOpenChange={setAddProperty}
            label="Add ticket property"
            onKeyDown={(event) =>
              addBlockerKey(event, () => work.openLink("blocked_by"))
            }
          >
            {missing.map((scope) => {
              const shortcut = ticketCommandActions.find(
                (action) => action.scope === scope,
              )?.shortcut;
              return (
                <DropdownMenuItem
                  key={scope}
                  onSelect={() => setAddProperty(scope)}
                >
                  {scope}
                  {scope !== "Project" && shortcut && (
                    <Kbd aria-hidden="true">{shortcutLabel(shortcut)}</Kbd>
                  )}
                </DropdownMenuItem>
              );
            })}
            {missing.length > 0 && <DropdownMenuSeparator />}
            {linkActions.map(({ kind, label }) => (
              <DropdownMenuItem
                key={kind}
                onSelect={() => work.openLink(kind)}
                {...(kind === "blocked_by" && { "aria-keyshortcuts": "B" })}
              >
                {label}
                {kind === "blocked_by" && <Kbd aria-hidden="true">B</Kbd>}
              </DropdownMenuItem>
            ))}
          </PropertyMenu>
        )}
      </span>
    </div>
  );
}
