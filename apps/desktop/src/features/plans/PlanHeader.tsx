import { useContext } from "react";
import { ContextGraphNavigation } from "@/features/documents/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { Archive, ArchiveRestore, Pencil, Plus } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { StatusDot } from "@/components/ui/status-dot";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import { plansClient, type Plan, type View } from "@/lib/api/plans";
import { statusCountKey, ticketStatuses } from "@/lib/statuses";
import { PlanDocuments } from "./PlanDocuments";
import { AddTicketsDialog } from "./AddTicketsDialog";
import type { PlanViewState } from "./usePlanView";
import "./plan.css";

const list = (names: string[]) =>
  names.length < 3
    ? names.join(" and ")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** The context line: how many tickets, and which projects they span. */
function planContext(
  members: View["members"],
  projects: { id: string; name: string }[],
) {
  const names = projects
    .filter((project) => members.some((item) => item.project_id === project.id))
    .map((project) => project.name);
  const tickets = `${members.length} ${members.length === 1 ? "ticket" : "tickets"}`;
  return names.length
    ? `Plan · ${tickets} across ${list(names)}`
    : `Plan · ${tickets}`;
}

/**
 * The Plan's name and state, status counts, and actions, shown above its
 * member list. Counts include every non-trashed member, subtickets too.
 */
export function PlanHeader({
  plan,
  plans,
  projects,
  state,
  children,
}: {
  children?: ReactNode;
  plan: Plan;
  plans: Plan[];
  projects: { id: string; name: string }[];
  state: PlanViewState;
}) {
  const { view, loadError, pending, actionError, run } = state;
  const openGraph = useContext(ContextGraphNavigation);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState("");
  const [editingPurpose, setEditingPurpose] = useState(false);
  const [purpose, setPurpose] = useState("");
  const [adding, setAdding] = useState(false);
  // The list's own copy is current after a change; the loaded view adds counts.
  const current = view?.plan.id === plan.id ? view.plan : plan;

  function startRename() {
    setName(current.name);
    setNameError("");
    setRenaming(true);
  }
  async function rename(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setNameError("Enter a name for this Plan.");
      return;
    }
    setNameError("");
    if (await run(() => plansClient.change(plan.id, name, null)))
      setRenaming(false);
  }
  return (
    <header className="plan-header">
      <div className="plan-title-row">
        <div className="plan-title">
          <div className="plan-name-row">
            <h1 id="tickets-heading" tabIndex={-1}>
              {current.name}
            </h1>
            <span className="plan-state">
              <StatusDot tone={current.archived ? "neutral" : "positive"} />
              {current.archived ? "Archived" : "Active"}
            </span>
          </div>
          <p>{view ? planContext(view.members, projects) : "Plan"}</p>
        </div>
        <div className="plan-actions">
          {openGraph && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => openGraph(plan.id)}
            >
              Context graph
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => setAdding(true)}
          >
            <Plus data-icon="inline-start" /> Add tickets
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={startRename}
          >
            <Pencil data-icon="inline-start" /> Rename
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            aria-describedby="plan-archive-note"
            onClick={() =>
              void run(() =>
                plansClient.change(plan.id, null, !current.archived),
              )
            }
          >
            {current.archived ? (
              <ArchiveRestore data-icon="inline-start" />
            ) : (
              <Archive data-icon="inline-start" />
            )}
            {current.archived ? "Reactivate" : "Archive"}
          </Button>
          {children}
        </div>
      </div>
      {renaming && (
        <form className="plan-rename" onSubmit={(event) => void rename(event)}>
          <Field data-invalid={nameError ? true : undefined}>
            <FieldLabel htmlFor="plan-rename-name">Plan name</FieldLabel>
            <Input
              id="plan-rename-name"
              value={name}
              autoFocus
              aria-invalid={nameError ? true : undefined}
              onChange={(event) => {
                setName(event.target.value);
                setNameError("");
              }}
            />
            {nameError && <FieldError>{nameError}</FieldError>}
          </Field>
          <Button type="submit" size="sm" disabled={pending}>
            Save name
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setRenaming(false)}
          >
            Cancel
          </Button>
        </form>
      )}
      {editingPurpose ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => plansClient.setPurpose(plan.id, purpose)).then(
              (saved) => {
                if (saved) setEditingPurpose(false);
              },
            );
          }}
        >
          <FieldLabel htmlFor="plan-purpose">Purpose</FieldLabel>
          <Input
            id="plan-purpose"
            value={purpose}
            onChange={(event) => setPurpose(event.target.value)}
            autoFocus
          />
          <Button type="submit" size="sm" disabled={pending}>
            Save purpose
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setEditingPurpose(false)}
          >
            Cancel
          </Button>
        </form>
      ) : (
        <div>
          {current.purpose && <p>{current.purpose}</p>}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setPurpose(current.purpose);
              setEditingPurpose(true);
            }}
          >
            {current.purpose ? "Edit purpose" : "Add purpose"}
          </Button>
        </div>
      )}
      {view && <PlanDocuments view={view} state={state} />}
      {(actionError || loadError) && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{actionError || loadError}</AlertDescription>
        </Alert>
      )}
      {view && (
        <dl className="plan-counts" aria-label="Tickets by status">
          {ticketStatuses.map((status) => (
            <div key={status}>
              <dt>
                <StatusIcon status={status} size={14} decorative />
                {status}
              </dt>
              <dd>{view.counts[statusCountKey[status]]}</dd>
            </div>
          ))}
        </dl>
      )}
      <p id="plan-archive-note" className="plan-note">
        {current.archived
          ? "Reactivating returns this Plan to the sidebar. Its tickets keep their status."
          : "Archiving hides this Plan from the sidebar. Its tickets stay searchable and unchanged."}{" "}
        Counts include parents and subtickets equally.
      </p>
      <AddTicketsDialog
        plan={current}
        plans={plans}
        open={adding}
        onOpenChange={setAdding}
        state={state}
      />
    </header>
  );
}
