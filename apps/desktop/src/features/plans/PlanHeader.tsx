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
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { PaneHeader, PaneHeaderButton } from "@/components/ui/list-header";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { ContextGraphNavigation } from "@/features/documents/navigation";
import { noun } from "@/lib/format";
import { PLAN_NAME_MAX_LENGTH } from "@/lib/limits";
import { plansClient, type Plan } from "@/lib/api/plans";
import { AddTicketsDialog } from "./AddTicketsDialog";
import { PlanDocumentPicker } from "./PlanDocuments";
import { PlanRing } from "./PlanProgress";
import { usePlanAction, type PlanViewState } from "./usePlanView";
import "./plan.css";

export type PlanMode = "overview" | "list" | "board" | "dependencies";

/** The controls shared by all four Plan views. */
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
  mode: PlanMode;
  onModeChange: (mode: PlanMode) => void;
  /** Filter and Display controls, reached through More. */
  controls?: ReactNode;
}) {
  const { view, pending, adding, setAdding } = state;
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
  const viewSwitch = (
    <SegmentedControl
      aria-label="Plan view"
      value={mode}
      onValueChange={onModeChange}
      options={[
        { value: "overview", label: "Overview" },
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
        titleLevel={mode === "overview" ? null : 1}
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
                      disabled={pending || !view}
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
      {renaming && (
        <span
          id="plan-context-note"
          className="plan-context-note"
          data-invalid={nameError ? "" : undefined}
          role={nameError ? "alert" : undefined}
        >
          {nameError || "Enter saves · Esc cancels"}
        </span>
      )}
      {view && (
        <PlanDocumentPicker
          view={view}
          state={state}
          linking={linking}
          onLinkingChange={setLinking}
          anchor={actionsButton}
        />
      )}
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
