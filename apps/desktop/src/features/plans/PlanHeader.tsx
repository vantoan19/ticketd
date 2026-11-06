import {
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { ContextGraphNavigation } from "@/features/documents/navigation";
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
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusDot } from "@/components/ui/status-dot";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import { plansClient, type Plan } from "@/lib/api/plans";
import { statusCountKey, ticketStatuses } from "@/lib/statuses";
import { PlanDocuments } from "./PlanDocuments";
import { AddTicketsDialog } from "./AddTicketsDialog";
import type { PlanViewState } from "./usePlanView";
import "./plan.css";

/**
 * The Plan's name and state, view toggle, actions, purpose, and status counts,
 * shown across the full width above the list and detail panes. Counts include every non-trashed member, subtickets too.
 */
export function PlanHeader({
  plan,
  plans,
  state,
  mode,
  onModeChange,
}: {
  plan: Plan;
  plans: Plan[];
  state: PlanViewState;
  mode: "list" | "dependencies";
  onModeChange: (mode: "list" | "dependencies") => void;
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

  const nameInput = useRef<HTMLInputElement>(null);
  const focusRename = useRef(false);
  function startRename() {
    setName(current.name);
    setNameError("");
    setRenaming(true);
    focusRename.current = true;
  }
  const renameAvailable = !current.archived && !pending && !renaming;
  // F2 renames from anywhere except while typing in a field.
  useEffect(() => {
    if (!renameAvailable) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "F2") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      event.preventDefault();
      setName(current.name);
      setNameError("");
      setRenaming(true);
      focusRename.current = true;
      window.setTimeout(() => nameInput.current?.select(), 0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [renameAvailable, current.name]);
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
      focusRename.current = false;
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
      <div className="plan-title-row" data-renaming={renaming || undefined}>
        {renaming ? (
          <>
            <Input
              ref={nameInput}
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
            {nameError ? (
              <span className="plan-name-error" role="alert">
                {nameError}
              </span>
            ) : (
              <span className="plan-rename-hint">
                <Kbd>Enter</Kbd> saves · <Kbd>Esc</Kbd> cancels
              </span>
            )}
            <PlanState current={current} />
          </>
        ) : (
          <>
            <h1 id="tickets-heading" tabIndex={-1}>
              {current.name}
            </h1>
            <PlanState current={current} />
          </>
        )}
        <span className="plan-title-spacer" />
        <div className="plan-actions">
          <SegmentedControl
            aria-label="Plan view"
            value={mode}
            onValueChange={onModeChange}
            options={[
              { value: "list", label: "List" },
              { value: "dependencies", label: "Dependencies" },
            ]}
          />
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
              <DropdownMenuContent
                align="end"
                sideOffset={4}
                className="plan-actions-menu"
                onCloseAutoFocus={(event) => {
                  // Rename puts the cursor in the title, not back on the menu.
                  if (!focusRename.current) return;
                  event.preventDefault();
                  focusRename.current = false;
                  window.setTimeout(() => {
                    nameInput.current?.focus();
                    nameInput.current?.select();
                  }, 0);
                }}
              >
                {canArchive && (
                  <DropdownMenuItem disabled={pending} onSelect={startRename}>
                    <Pencil /> Rename
                    <DropdownMenuShortcut>F2</DropdownMenuShortcut>
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
            placeholder="Add a purpose: the outcome this Plan pursues"
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
              {current.purpose
                ? "Edit purpose"
                : "Add a purpose: the outcome this Plan pursues"}
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
                title={status}
                data-zero={view.counts[statusCountKey[status]] === 0}
              >
                <dt>
                  <StatusIcon status={status} size={14} decorative />
                  <span className="plan-count-name">{status}</span>
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

function PlanState({ current }: { current: Plan }) {
  return (
    <span className="plan-state">
      <StatusDot tone={current.archived ? "neutral" : "positive"} />
      {current.archived ? "Archived Plan" : "Active Plan"}
    </span>
  );
}
