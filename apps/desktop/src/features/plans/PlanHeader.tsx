import {
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  Archive,
  ArchiveRestore,
  FileText,
  MoreHorizontal,
  Network,
  Pencil,
  Plus,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Count } from "@/components/ui/count";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FailureState } from "@/components/ui/failure-alert";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { PaneHeader, PaneHeaderButton } from "@/components/ui/list-header";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Tooltip } from "@/components/ui/tooltip";
import { ContextGraphNavigation } from "@/features/documents/navigation";
import { noun } from "@/lib/format";
import { PLAN_NAME_MAX_LENGTH } from "@/lib/limits";
import { plansClient, type Plan } from "@/lib/api/plans";
import { AddTicketsDialog } from "./AddTicketsDialog";
import { PlanDocuments } from "./PlanDocuments";
import { PlanRing, PlanSplitBar } from "./PlanProgress";
import { usePlanAction, type PlanViewState } from "./usePlanView";
import "./plan.css";

type Mode = "list" | "board" | "dependencies";

/**
 * A Plan's header across both panes (DESIGN.md section 10): one responsive pane
 * header (ring, name and count, List/Board/Flow, "Add tickets", "…")
 * and a reserved summary (purpose, split progress and spec). Both keep their
 * height in every state: renaming, editing the
 * purpose, archived, failed. Outcomes and failures go to the status line;
 * archiving acts at once with Undo.
 */
export function PlanHeader({
  plan,
  plans,
  state,
  mode,
  onModeChange,
  controls,
}: {
  plan: Plan;
  plans: Plan[];
  state: PlanViewState;
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  /** Filter and Display controls, reached through More. */
  controls?: ReactNode;
}) {
  const { view, loadError, reload, pending, adding, setAdding } = state;
  const act = usePlanAction(state);
  const openGraph = useContext(ContextGraphNavigation);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState("");
  const [linking, setLinking] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  // The list's own copy is current after a change; the loaded view adds counts.
  const current = view?.plan.id === plan.id ? view.plan : plan;

  const header = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const actionsButton = useRef<HTMLButtonElement>(null);
  // What a menu item opened, so the menu does not take focus back from it.
  const afterMenu = useRef<"rename" | "link" | "options" | null>(null);
  function startRename() {
    setName(current.name);
    setNameError("");
    setRenaming(true);
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
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [renameAvailable, current.name]);
  useEffect(() => {
    if (!renaming) return;
    nameInput.current?.focus();
    nameInput.current?.select();
  }, [renaming]);
  function endRename() {
    setRenaming(false);
    setNameError("");
    window.setTimeout(() =>
      document.getElementById("tickets-heading")?.focus(),
    );
  }
  async function rename() {
    if (!name.trim()) {
      setNameError("A Plan needs a name.");
      return;
    }
    if (name.trim() === current.name) return endRename();
    if (
      await act(
        () => plansClient.change(plan.id, name, null),
        `rename ${current.name}`,
      )
    )
      endRename();
  }
  function renameKey(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      void rename();
    } else if (event.key === "Escape") {
      event.stopPropagation();
      endRename();
    }
  }
  const archive = () =>
    void act(
      () => plansClient.change(plan.id, null, true),
      `archive ${current.name}`,
      {
        message: `Archived ${current.name}`,
        undo: () => state.apply(() => plansClient.change(plan.id, null, false)),
      },
    );
  const reactivate = () =>
    void act(
      () => plansClient.change(plan.id, null, false),
      `reactivate ${current.name}`,
    );

  // Counts include parents and subtickets; a Duplicate is resolved by its
  // original and a Canceled ticket will not be done, so neither holds
  // progress back.
  const total = view
    ? Object.values(view.counts).reduce((sum, n) => sum + n, 0)
    : null;
  const done = view?.counts.done ?? 0;
  const counted = view
    ? (total ?? 0) - view.counts.canceled - view.counts.duplicate
    : 0;

  const viewSwitch = (
    <SegmentedControl
      aria-label="Plan view"
      value={mode}
      onValueChange={onModeChange}
      options={[
        { value: "list", label: "List" },
        { value: "board", label: "Board" },
        { value: "dependencies", label: "Flow" },
      ]}
    />
  );
  return (
    <div className="plan-header" ref={header}>
      <PaneHeader
        variant="responsive"
        title={current.name}
        titleId="tickets-heading"
        icon={
          view ? (
            <PlanRing name={current.name} counts={view.counts} decorative />
          ) : (
            <span className="plan-ring-slot" />
          )
        }
        titleEditor={
          renaming ? (
            // The field takes the title's place at its height and weight.
            <span className="plan-name-field">
              <Input
                ref={nameInput}
                variant="inline"
                className="h-8"
                aria-label="Plan name"
                maxLength={PLAN_NAME_MAX_LENGTH}
                aria-invalid={nameError ? true : undefined}
                aria-describedby="plan-context-note"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameError("");
                }}
                onKeyDown={renameKey}
              />
            </span>
          ) : undefined
        }
        count={
          total !== null &&
          total > 0 && (
            <Count>
              {total}
              <span className="sr-only"> {noun(total, "ticket")}</span>
            </Count>
          )
        }
        actions={
          <>
            {viewSwitch}
            {current.archived ? (
              <PaneHeaderButton
                variant="outline"
                icon={<ArchiveRestore />}
                label="Reactivate"
                disabled={pending}
                onClick={reactivate}
              />
            ) : (
              <PaneHeaderButton
                variant="outline"
                icon={<Plus />}
                label="Add tickets"
                disabled={pending}
                onClick={() => setAdding(true)}
              />
            )}
            {/* An archived Plan has one action left: a direct button, not a
                one-item menu (plans PL-11). */}
            {current.archived ? (
              openGraph && (
                <IconButton
                  label="Open graph"
                  onClick={() => openGraph(plan.id)}
                >
                  <Network />
                </IconButton>
              )
            ) : (
              <Popover open={optionsOpen} onOpenChange={setOptionsOpen}>
                <DropdownMenu>
                  <PopoverAnchor asChild>
                    <DropdownMenuTrigger asChild>
                      <IconButton ref={actionsButton} label="Plan actions">
                        <MoreHorizontal />
                      </IconButton>
                    </DropdownMenuTrigger>
                  </PopoverAnchor>
                  <DropdownMenuContent
                    align="end"
                    onCloseAutoFocus={(event) => {
                      // Rename and Link move focus to what they opened.
                      if (!afterMenu.current) return;
                      event.preventDefault();
                      if (afterMenu.current === "rename") {
                        nameInput.current?.focus();
                        nameInput.current?.select();
                      }
                      afterMenu.current = null;
                    }}
                  >
                    <DropdownMenuItem
                      disabled={pending}
                      onSelect={() => {
                        afterMenu.current = "rename";
                        startRename();
                      }}
                    >
                      <Pencil /> Rename
                      <DropdownMenuShortcut>F2</DropdownMenuShortcut>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={pending}
                      onSelect={() => {
                        afterMenu.current = "link";
                        setLinking(true);
                      }}
                    >
                      <FileText /> Link a Document…
                    </DropdownMenuItem>
                    {openGraph && (
                      <DropdownMenuItem onSelect={() => openGraph(plan.id)}>
                        <Network /> Open graph
                      </DropdownMenuItem>
                    )}
                    {controls && (
                      <DropdownMenuItem
                        onSelect={() => {
                          afterMenu.current = "options";
                          setOptionsOpen(true);
                        }}
                      >
                        Filter and display…
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem disabled={pending} onSelect={archive}>
                      <Archive /> Archive Plan
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <PopoverContent
                  align="end"
                  aria-label="Plan list options"
                  onCloseAutoFocus={(event) => {
                    event.preventDefault();
                    actionsButton.current?.focus();
                  }}
                >
                  <div className="plan-list-options">{controls}</div>
                </PopoverContent>
              </Popover>
            )}
          </>
        }
      >
        {current.archived && <Badge size="sm">Archived</Badge>}
      </PaneHeader>
      <div
        className="plan-context ui-plan-summary"
        aria-label="Plan context"
        role="group"
        aria-busy={!view && !loadError}
      >
        <PlanPurpose
          key={plan.id}
          purpose={current.purpose}
          readOnly={current.archived || renaming}
          pending={pending}
          save={(purpose) =>
            act(
              () => plansClient.setPurpose(plan.id, purpose),
              "save the purpose",
            )
          }
        />
        <div className="plan-summary-row">
          {renaming ? (
            <span
              id="plan-context-note"
              className="plan-context-note"
              data-invalid={nameError ? "" : undefined}
              role={nameError ? "alert" : undefined}
            >
              {nameError || "Enter saves · Esc cancels"}
            </span>
          ) : loadError ? (
            <FailureState size="inline" failure={loadError} onRetry={reload} />
          ) : view ? (
            <>
              <PlanSplitBar
                variant="summary"
                className="plan-summary-bar"
                name={current.name}
                counts={view.counts}
              />
              <span className="plan-progress ui-plan-progress">
                {done} of {counted} done
              </span>
              <span className="plan-summary-legend">
                {[
                  view.counts.in_review
                    ? `${view.counts.in_review} in review`
                    : null,
                  view.counts.in_progress
                    ? `${view.counts.in_progress} in progress`
                    : null,
                  `${view.counts.todo} to do, ${view.members.filter((member) => member.availability === "Ready").length} ready`,
                  view.counts.canceled
                    ? `${view.counts.canceled} canceled, not counted`
                    : null,
                  view.counts.duplicate
                    ? `${view.counts.duplicate} duplicates, not counted`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              <PlanDocuments
                view={view}
                state={state}
                linking={linking}
                onLinkingChange={setLinking}
                returnFocus={actionsButton}
              />
            </>
          ) : (
            <div
              className="plan-summary-loading"
              aria-label="Loading Plan progress"
            >
              <Skeleton className="h-2 w-full" />
            </div>
          )}
        </div>
      </div>
      <AddTicketsDialog
        plan={current}
        plans={plans}
        open={adding}
        onOpenChange={setAdding}
        state={state}
      />
    </div>
  );
}

/**
 * The purpose, edited in place in the context line: click (or Enter) turns it
 * into a one-line field of the same height; Enter or leaving the field saves,
 * Escape keeps the saved text. An empty purpose reads "Add purpose".
 */
function PlanPurpose({
  purpose,
  readOnly,
  pending,
  save,
}: {
  purpose: string;
  readOnly: boolean;
  pending: boolean;
  save: (purpose: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const saving = useRef(false);
  if (readOnly)
    return (
      <Tooltip content={purpose} overflowOnly>
        <span className="plan-purpose ui-plan-purpose" tabIndex={0}>
          {purpose || "No purpose"}
        </span>
      </Tooltip>
    );
  async function commit() {
    // Enter then the blur it causes must save once.
    if (draft === null || saving.current) return;
    if (draft.trim() === purpose.trim()) return close();
    saving.current = true;
    const saved = await save(draft.trim());
    saving.current = false;
    if (saved) close();
  }
  function close() {
    setDraft(null);
    window.setTimeout(() => button.current?.focus());
  }
  if (draft !== null)
    return (
      <span className="plan-purpose-field ui-plan-purpose">
        <Input
          variant="inline"
          className="h-6"
          aria-label="Purpose"
          placeholder="e.g. Make the board feel stable and fast"
          autoFocus
          value={draft}
          readOnly={pending}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commit();
            } else if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
          }}
        />
      </span>
    );
  return (
    <Tooltip
      content={purpose ? "Edit purpose" : "The outcome this Plan pursues"}
    >
      <button
        ref={button}
        type="button"
        className="plan-purpose ui-plan-purpose"
        data-empty={purpose ? undefined : ""}
        onClick={() => setDraft(purpose)}
      >
        {purpose ? (
          <>
            <span className="sr-only">Edit purpose: </span>
            <span className="plan-purpose-text">{purpose}</span>
          </>
        ) : (
          "Add purpose"
        )}
        <Pencil aria-hidden="true" />
      </button>
    </Tooltip>
  );
}
