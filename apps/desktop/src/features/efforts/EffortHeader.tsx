import { useState, type FormEvent } from "react";
import { Archive, ArchiveRestore, Pencil, Plus } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { StatusDot } from "@/components/ui/status-dot";
import { StatusIcon, ticketStatuses } from "@/features/tickets/StatusIcon";
import { effortsClient, type Effort, type View } from "@/lib/api/efforts";
import { AddTicketsDialog } from "./AddTicketsDialog";
import type { EffortViewState } from "./useEffortView";
import "./effort.css";

const countKeys = {
  Todo: "todo",
  "In progress": "in_progress",
  "In review": "in_review",
  Done: "done",
  Canceled: "canceled",
  Duplicate: "duplicate",
} as const;

const list = (names: string[]) =>
  names.length < 3
    ? names.join(" and ")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** The context line: how many tickets, and which projects they span. */
function effortContext(
  members: View["members"],
  projects: { id: string; name: string }[],
) {
  const names = projects
    .filter((project) => members.some((item) => item.project_id === project.id))
    .map((project) => project.name);
  const tickets = `${members.length} ${members.length === 1 ? "ticket" : "tickets"}`;
  return names.length
    ? `Effort · ${tickets} across ${list(names)}`
    : `Effort · ${tickets}`;
}

/**
 * The Effort's name and state, status counts, and actions, shown above its
 * member list. Counts include every non-trashed member, subtickets too.
 */
export function EffortHeader({
  effort,
  efforts,
  projects,
  state,
}: {
  effort: Effort;
  efforts: Effort[];
  projects: { id: string; name: string }[];
  state: EffortViewState;
}) {
  const { view, loadError, pending, actionError, run } = state;
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState("");
  const [adding, setAdding] = useState(false);
  // The list's own copy is current after a change; the loaded view adds counts.
  const current = view?.effort.id === effort.id ? view.effort : effort;

  function startRename() {
    setName(current.name);
    setNameError("");
    setRenaming(true);
  }
  async function rename(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setNameError("Enter a name for this Effort.");
      return;
    }
    setNameError("");
    if (await run(() => effortsClient.change(effort.id, name, null)))
      setRenaming(false);
  }
  return (
    <header className="effort-header">
      <div className="effort-title-row">
        <div className="effort-title">
          <div className="effort-name-row">
            <h1 id="tickets-heading" tabIndex={-1}>
              {current.name}
            </h1>
            <span className="effort-state">
              <StatusDot tone={current.archived ? "neutral" : "positive"} />
              {current.archived ? "Archived" : "Active"}
            </span>
          </div>
          <p>{view ? effortContext(view.members, projects) : "Effort"}</p>
        </div>
        <div className="effort-actions">
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
            aria-describedby="effort-archive-note"
            onClick={() =>
              void run(() =>
                effortsClient.change(effort.id, null, !current.archived),
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
        </div>
      </div>
      {renaming && (
        <form
          className="effort-rename"
          onSubmit={(event) => void rename(event)}
        >
          <Field data-invalid={nameError ? true : undefined}>
            <FieldLabel htmlFor="effort-rename-name">Effort name</FieldLabel>
            <Input
              id="effort-rename-name"
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
      {(actionError || loadError) && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{actionError || loadError}</AlertDescription>
        </Alert>
      )}
      {view && (
        <dl className="effort-counts" aria-label="Tickets by status">
          {ticketStatuses.map((status) => (
            <div key={status}>
              <dt>
                <StatusIcon status={status} size={14} decorative />
                {status}
              </dt>
              <dd>{view.counts[countKeys[status]]}</dd>
            </div>
          ))}
        </dl>
      )}
      <p id="effort-archive-note" className="effort-note">
        {current.archived
          ? "Reactivating returns this Effort to the sidebar. Its tickets keep their status."
          : "Archiving hides this Effort from the sidebar. Its tickets stay searchable and unchanged."}{" "}
        Counts include parents and subtickets equally.
      </p>
      <AddTicketsDialog
        effort={current}
        efforts={efforts}
        open={adding}
        onOpenChange={setAdding}
        state={state}
      />
    </header>
  );
}
