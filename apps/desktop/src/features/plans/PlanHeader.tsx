import { useContext } from "react";
import { ContextGraphNavigation } from "@/features/documents/navigation";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import {
  Archive,
  ArchiveRestore,
  MoreHorizontal,
  Network,
  Pencil,
  Plus,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { StatusDot } from "@/components/ui/status-dot";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import { plansClient, type Plan } from "@/lib/api/plans";
import { statusCountKey, ticketStatuses } from "@/lib/statuses";
import { PlanDocuments } from "./PlanDocuments";
import { AddTicketsDialog } from "./AddTicketsDialog";
import type { PlanViewState } from "./usePlanView";
import "./plan.css";

/**
 * The Plan's name and state, status counts, and actions, shown above its
 * member list. Counts include every non-trashed member, subtickets too.
 */
export function PlanHeader({
  plan,
  plans,
  state,
  children,
}: {
  children?: ReactNode;
  plan: Plan;
  plans: Plan[];
  state: PlanViewState;
}) {
  const { view, loadError, pending, actionError, run } = state;
  const openGraph = useContext(ContextGraphNavigation);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState("");
  const [editingPurpose, setEditingPurpose] = useState(false);
  const [purpose, setPurpose] = useState("");
  const [archiving, setArchiving] = useState(false);
  const { adding, setAdding } = state;
  // The list's own copy is current after a change; the loaded view adds counts.
  const current = view?.plan.id === plan.id ? view.plan : plan;

  function startRename() {
    setName(current.name);
    setNameError("");
    setRenaming(true);
  }
  async function rename() {
    if (!name.trim()) {
      setNameError("Enter a name for this Plan.");
      return;
    }
    setNameError("");
    if (await run(() => plansClient.change(plan.id, name, null)))
      setRenaming(false);
  }
  function renameKey(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      void rename();
    } else if (event.key === "Escape") {
      event.stopPropagation();
      setRenaming(false);
    }
  }
  // Counts include parents and subtickets; a Duplicate is resolved by its
  // original and a Canceled ticket will not be done, so neither holds
  // progress back.
  const done = view?.counts.done ?? 0;
  const counted = view
    ? Object.values(view.counts).reduce((sum, n) => sum + n, 0) -
      view.counts.canceled -
      view.counts.duplicate
    : 0;
  const canArchive = !current.archived;
  return (
    <header className="plan-header">
      <div className="plan-title-row">
        {renaming ? (
          <>
            <Input
              className="plan-name-input"
              aria-label="Plan name"
              value={name}
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
              aria-invalid={nameError ? true : undefined}
              onChange={(event) => {
                setName(event.target.value);
                setNameError("");
              }}
              onKeyDown={renameKey}
            />
            {nameError && (
              <span className="plan-name-error" role="alert">
                {nameError}
              </span>
            )}
          </>
        ) : (
          <>
            <h1 id="tickets-heading" tabIndex={-1}>
              {current.name}
            </h1>
            <span className="plan-state">
              <StatusDot tone={current.archived ? "neutral" : "positive"} />
              {current.archived ? "Archived" : "Active"}
            </span>
          </>
        )}
        <span className="plan-title-spacer" />
        <div className="plan-actions">
          {children}
          {current.archived ? (
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                void run(() => plansClient.change(plan.id, null, false))
              }
            >
              <ArchiveRestore data-icon="inline-start" /> Reactivate
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => setAdding(true)}
            >
              <Plus data-icon="inline-start" /> Add tickets
            </Button>
          )}
          {(canArchive || openGraph) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label="Plan actions">
                  <MoreHorizontal />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={4}>
                {canArchive && (
                  <DropdownMenuItem disabled={pending} onSelect={startRename}>
                    <Pencil /> Rename
                  </DropdownMenuItem>
                )}
                {openGraph && (
                  <DropdownMenuItem onSelect={() => openGraph(plan.id)}>
                    <Network /> Open context graph
                  </DropdownMenuItem>
                )}
                {canArchive && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      disabled={pending}
                      onSelect={() => setArchiving(true)}
                    >
                      <Archive /> Archive Plan…
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
      {editingPurpose ? (
        <form
          className="plan-purpose-form"
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
        <div className="plan-purpose-row">
          {current.purpose && <p className="plan-purpose">{current.purpose}</p>}
          {!current.archived && (
            <Button
              className="plan-purpose-edit"
              variant="ghost"
              size="sm"
              onClick={() => {
                setPurpose(current.purpose);
                setEditingPurpose(true);
              }}
            >
              <Pencil data-icon="inline-start" />
              {current.purpose ? "Edit purpose" : "Add purpose"}
            </Button>
          )}
        </div>
      )}
      {(actionError || loadError) && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{actionError || loadError}</AlertDescription>
        </Alert>
      )}
      {view && (
        <div className="plan-summary">
          <span className="plan-progress">
            <span className="plan-progress-bar" aria-hidden="true">
              <span
                style={{ width: `${counted ? (done / counted) * 100 : 0}%` }}
              />
            </span>
            {done} of {counted} done
          </span>
          <span className="plan-summary-rule" aria-hidden="true" />
          <dl
            className="plan-counts"
            aria-label="Tickets by status"
            title="Counts include parents and subtickets equally."
          >
            {ticketStatuses.map((status) => (
              <div
                key={status}
                data-zero={view.counts[statusCountKey[status]] === 0}
              >
                <dt>
                  <StatusIcon status={status} size={14} decorative />
                  {status}
                </dt>
                <dd>{view.counts[statusCountKey[status]]}</dd>
              </div>
            ))}
          </dl>
          <PlanDocuments view={view} state={state} />
        </div>
      )}
      <Dialog open={archiving} onOpenChange={setArchiving}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive {current.name}?</DialogTitle>
            <DialogDescription>
              Archiving hides this Plan from the sidebar. Its tickets stay
              searchable and unchanged, and you can reactivate it later.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setArchiving(false)}>
              Cancel
            </Button>
            <Button
              disabled={pending}
              onClick={() =>
                void run(() => plansClient.change(plan.id, null, true)).then(
                  () => setArchiving(false),
                )
              }
            >
              Archive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
