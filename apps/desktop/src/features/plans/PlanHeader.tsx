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
import { FailureAlert } from "@/components/ui/failure-alert";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
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
import { Progress } from "@/components/ui/progress";

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
  mode: "list" | "board" | "dependencies";
  onModeChange: (mode: "list" | "board" | "dependencies") => void;
}) {
  const { view, loadError, reload, pending, actionError, retry, run } = state;
  const openGraph = useContext(ContextGraphNavigation);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState("");
  const [editingPurpose, setEditingPurpose] = useState(false);
  const [purpose, setPurpose] = useState("");
  const [archiving, setArchiving] = useState(false);
  // The archive failed while its dialog was open: the error stays in the dialog.
  const [archiveFailed, setArchiveFailed] = useState(false);
  const { adding, setAdding } = state;
  // The list's own copy is current after a change; the loaded view adds counts.
  const current = view?.plan.id === plan.id ? view.plan : plan;

  const header = useRef<HTMLElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const focusRename = useRef(false);
  function startRename() {
    setName(current.name);
    setNameError("");
    setRenaming(true);
    focusRename.current = true;
  }
  const renameAvailable = !current.archived && !pending && !renaming;
  // F2 renames the Plan from its header, or when nothing has focus. In the list
  // or detail panes focus is on a ticket, so F2 there is not about the Plan.
  useEffect(() => {
    if (!renameAvailable) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "F2") return;
      const target = event.target as HTMLElement | null;
      const inHeader = Boolean(target && header.current?.contains(target));
      if (!inHeader && target !== document.body) return;
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
    if (
      await run(
        () => plansClient.change(plan.id, name, null),
        `rename ${current.name}`,
      )
    )
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
    <header className="plan-header" ref={header}>
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
              { value: "board", label: "Board" },
              { value: "dependencies", label: "Dependencies" },
            ]}
          />
          {current.archived ? (
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                void run(
                  () => plansClient.change(plan.id, null, false),
                  `reactivate ${current.name}`,
                )
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
                sideOffset={12}
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
                      onSelect={() => {
                        setArchiveFailed(false);
                        setArchiving(true);
                      }}
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
            void run(
              () => plansClient.setPurpose(plan.id, purpose),
              "save the purpose",
            ).then((saved) => {
              if (saved) setEditingPurpose(false);
            });
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
      {actionError && !archiving ? (
        <FailureAlert
          size="compact"
          failure={actionError}
          onRetry={() => void retry()}
        />
      ) : (
        loadError && (
          <FailureAlert size="compact" failure={loadError} onRetry={reload} />
        )
      )}
      {view && (
        <div className="plan-summary">
          <span className="plan-progress">
            <Progress
              aria-label="Plan progress"
              value={done}
              max={counted || 1}
            />
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
      <DialogShell
        open={archiving}
        onOpenChange={setArchiving}
        width={480}
        title={`Archive ${current.name}?`}
        description="Archiving hides this Plan from the sidebar. Its tickets stay searchable and unchanged, and you can reactivate it later."
        primaryLabel={pending ? "Archiving…" : "Archive"}
        // While the archive runs, the primary stays disabled with nothing to explain.
        blockedReason={pending ? "" : null}
        busy={pending}
        onSubmit={() => {
          setArchiveFailed(false);
          void run(
            () => plansClient.change(plan.id, null, true),
            `archive ${current.name}`,
          ).then((archived) => {
            // A failed archive keeps the dialog open with the reason; Archive
            // is the retry.
            if (archived) setArchiving(false);
            else setArchiveFailed(true);
          });
        }}
      >
        {archiveFailed && actionError && (
          <FailureAlert size="compact" failure={actionError} />
        )}
      </DialogShell>
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
