import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { m } from "motion/react";
import { Presence } from "@/components/ui/motion";
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Copy,
  Folder,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  Plus,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Count } from "@/components/ui/count";
import { DialogShell } from "@/components/ui/dialog-shell";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { FailureAlert } from "@/components/ui/failure-alert";
import { IconButton } from "@/components/ui/icon-button";
import { enter } from "@/components/ui/enter";
import { ManagementPage, PageHeader } from "@/components/ui/page-header";
import { PathText } from "@/components/ui/path-text";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { arrival, departure, rowTokens } from "@/components/ui/row-motion";
import { useProjectLifecycle } from "./useProjectLifecycle";
import { Skeleton } from "@/components/ui/skeleton";
import { useCopy } from "@/components/ui/use-copy";
import {
  useStatusLine,
  type StatusLine,
} from "@/components/ui/use-status-line";
import { client, type Project } from "@/lib/api/client";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { workspaceClient } from "@/lib/api/workspace";
import { emptyCopy } from "@/lib/empty-copy";
import { plural } from "@/lib/format";
import { allowRemoval } from "@/lib/removal-guard";
import { fileManagerName } from "@/lib/platform";
import { ProjectIcon } from "@/features/projects/ProjectIcon";
import { FolderPicker } from "@/features/projects/FolderPicker";
import { ProjectFormDialog } from "@/features/projects/ProjectFormDialog";
import "./projects.css";

type OpenDialog =
  | { kind: "project" }
  | { kind: "edit"; id: string }
  | { kind: "checkout"; id: string };

/** What a project's tickets add up to, once counted. */
type TicketCount = { total: number; open: number };

const COUNT_FILTER = {
  query: "",
  unlinked: false,
  plan: null,
  status: null,
  tags: [],
  availability: null,
  family: null,
  limit: 1,
  offset: 0,
};

/** "10 tickets · 8 open · 2 checkouts", as far as it is known. */
function projectMeta(project: Project, count: TicketCount | undefined) {
  return [
    count && plural(count.total, "ticket"),
    count && count.total > 0 && `${count.open} open`,
    plural(project.paths.length, "checkout"),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Shows a failure on the page's status line, with Retry when it can work. */
function reportFailure(
  statusLine: StatusLine,
  failure: FailureDescription,
  retry?: () => unknown,
) {
  statusLine.show({
    tone: "error",
    message: `${failure.title}. ${failure.sentence}`,
    details: failure.details,
    ...(retry &&
      failure.action === "retry" && { action: { label: "Retry", run: retry } }),
  });
}

/** One checkout: its path (muted, shortened in the middle) and its actions. */
function CheckoutRow({
  path,
  first,
  disabled,
  onRemove,
}: {
  path: string;
  first: boolean;
  disabled: boolean;
  onRemove?: () => void;
}) {
  const manager = fileManagerName();
  const statusLine = useStatusLine();
  const reveal = () =>
    void workspaceClient
      .reveal(path)
      .catch((reason) =>
        reportFailure(
          statusLine,
          describeFailure(reason, `show it in ${manager}`),
          reveal,
        ),
      );
  return (
    <li className="checkout-row">
      <Folder aria-hidden="true" className="checkout-icon" />
      <span className="checkout-path">
        <PathText path={path} layout="inline" />
      </span>
      {first && <span className="checkout-note">First checkout</span>}
      <span className="checkout-actions">
        <CopyButton
          label="Copy path"
          subject={path}
          text={path}
          disabled={disabled}
        />
        <IconButton
          label={`Show in ${manager}`}
          onClick={reveal}
          disabled={disabled}
        >
          <FolderOpen />
        </IconButton>
        {onRemove && (
          <IconButton
            label="Remove checkout"
            onClick={onRemove}
            disabled={disabled}
          >
            <X />
          </IconButton>
        )}
      </span>
    </li>
  );
}

/**
 * The Projects page (DESIGN.md section 10): a management page of calm project
 * rows (icon, name, "10 tickets · 8 open · 2 checkouts", Open tickets, one
 * "…") that open to their checkouts. Removing a checkout acts at once with
 * Undo; write failures stay in their dialog.
 */
export function Projects({
  projects,
  archived = false,
  onArchivedChange,
  loading,
  onChange,
  onOpenTickets,
  onShowUnassigned,
  onConnectSource,
}: {
  projects: Project[];
  archived?: boolean;
  onArchivedChange?: (archived: boolean) => void;
  loading: boolean;
  onChange: () => Promise<void>;
  /** Shows that project's tickets. */
  onOpenTickets?: (project: Project) => void;
  /** Opens the tickets that belong to no project. */
  onShowUnassigned?: () => void;
  onConnectSource?: (projectId: string) => void;
}) {
  const statusLine = useStatusLine();
  const { copy } = useCopy();
  const shown = projects.filter(
    (project) => Boolean(project.archived) === archived,
  );
  const rowActions = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterChange = useRef<{
    id: string;
    archived: boolean;
    target?: string;
  } | null>(null);
  const lastArchive = useRef(0);
  const lifecycle = useProjectLifecycle(onChange);
  const tokens = rowTokens();
  const page = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const focus = focusAfterChange.current;
    if (!focus) return;
    const project = projects.find((project) => project.id === focus.id);
    if (!project || Boolean(project.archived) !== focus.archived) return;
    focusAfterChange.current = null;
    if (page.current?.closest("[hidden]")) return;
    (
      rowActions.current.get(focus.target ?? "") ??
      page.current?.querySelector<HTMLElement>("#projects-heading")
    )?.focus();
  }, [projects]);
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const [closedForArchive, setClosedForArchive] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const sourceReview = useRef<string | null>(null);
  const [checkoutDrafts, setCheckoutDrafts] = useState<Record<string, string>>(
    {},
  );
  // A failed write: shown above the dialog footer, never on a valid field.
  const [error, setError] = useState<FailureDescription | null>(null);
  const [pending, setPending] = useState(false);
  const [counts, setCounts] = useState<Record<string, TicketCount>>({});
  const [unassigned, setUnassigned] = useState(0);
  // A second click lands on the row that moved up: ignore it for 400ms (P7).
  const lastRemoval = useRef(0);

  useEffect(() => {
    let active = true;
    for (const item of projects)
      void client
        .countTickets({ ...COUNT_FILTER, project: item.id })
        .then((c) => {
          if (!active) return;
          const open = c.total - c.done - c.canceled - c.duplicate;
          setCounts((old) => ({ ...old, [item.id]: { total: c.total, open } }));
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [projects]);

  useEffect(() => {
    let active = true;
    void client
      .countTickets({ ...COUNT_FILTER, project: null, unlinked: true })
      .then((c) => {
        if (active) setUnassigned(c.total);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [projects]);

  const editing = projects.find((item) => item.id === editingId);
  const checkoutProject =
    dialog?.kind === "checkout"
      ? projects.find((item) => item.id === dialog.id)
      : undefined;
  const checkoutPath = checkoutProject
    ? (checkoutDrafts[checkoutProject.id] ?? "")
    : "";

  const archivedDialog =
    (dialog?.kind === "edit" && editing?.archived) || checkoutProject?.archived;
  if (archivedDialog) {
    setClosedForArchive(true);
    closeDialog();
  }

  function closeDialog() {
    setDialog(null);
  }

  function open(next: OpenDialog) {
    setClosedForArchive(false);
    setError(null);
    if (next.kind !== "checkout")
      setEditingId(next.kind === "edit" ? next.id : null);
    setDialog(next);
  }
  /** Runs a dialog's write, refreshes, and reports whether it all succeeded. */
  async function save(fn: () => Promise<unknown>, action: string) {
    setPending(true);
    setError(null);
    try {
      await fn();
      await onChange();
      return true;
    } catch (reason) {
      setError(describeFailure(reason, action));
      return false;
    } finally {
      setPending(false);
    }
  }
  function drop(
    setter: (
      fn: (old: Record<string, string>) => Record<string, string>,
    ) => void,
    key: string,
  ) {
    setter((old) => {
      const next = { ...old };
      delete next[key];
      return next;
    });
  }
  function projectSaved(project: Project) {
    void onChange();
    if (project.remote && project.remote !== editing?.remote)
      sourceReview.current = project.id;
  }

  async function registerCheckout() {
    if (!checkoutProject) return;
    const saved = await save(
      () => client.registerCheckout(checkoutProject.id, checkoutPath),
      "register the checkout",
    );
    if (!saved) return;
    drop(setCheckoutDrafts, checkoutProject.id);
    setExpanded((old) => ({ ...old, [checkoutProject.id]: true }));
    setDialog(null);
  }
  /** Removing a checkout is reversible (register it again): act, then Undo. */
  async function removeCheckout(project: Project, path: string) {
    if (!allowRemoval(lastRemoval)) return;
    const folder =
      path
        .replace(/[\\/]+$/, "")
        .split(/[\\/]/)
        .pop() || path;
    try {
      await client.removeCheckout(project.id, path);
      await onChange();
      statusLine.show({
        message: `Removed checkout ${folder}`,
        undo: async () => {
          await client.registerCheckout(project.id, path);
          await onChange();
        },
      });
    } catch (reason) {
      reportFailure(
        statusLine,
        describeFailure(reason, `remove the checkout ${folder}`),
        () => removeCheckout(project, path),
      );
    }
  }
  function changeArchiveState(project: Project) {
    if (!archived && !allowRemoval(lastArchive)) return;
    const index = shown.findIndex(({ id }) => id === project.id);
    const neighbor = shown[index + 1] ?? shown[index - 1];
    void lifecycle.change(project, !archived, {
      beforeRefresh: () => {
        focusAfterChange.current = {
          id: project.id,
          archived: !archived,
          ...(neighbor && { target: neighbor.id }),
        };
      },
      beforeUndoRefresh: () => {
        focusAfterChange.current = {
          id: project.id,
          archived,
          target: project.id,
        };
      },
    });
  }

  async function copyId(project: Project) {
    const done = await copy("Project ID", project.id);
    statusLine.show(
      done
        ? { message: `Copied the project ID of ${project.name}` }
        : {
            tone: "error",
            message: "Couldn't copy the project ID. Your clipboard refused it.",
          },
    );
  }

  const newProject = (
    <Button type="button" size="sm" onClick={() => open({ kind: "project" })}>
      <Plus aria-hidden />
      New project
    </Button>
  );
  const blocked = pending ? "Saving…" : null;
  const returnFocus = () => {
    const header =
      page.current?.querySelector<HTMLElement>("#projects-heading");
    return closedForArchive ? (header ?? null) : null;
  };

  return (
    // The page stays mounted while another is shown; its entrance (enter.ts)
    // plays again each time it comes back from `hidden`.
    <ManagementPage ownEntrance aria-labelledby="projects-heading">
      <div ref={page} {...enter(0)}>
        <PageHeader
          title="Projects"
          titleId="projects-heading"
          {...(projects.length > 0 && {
            wrapActions: true,
            count: <Count>{shown.length}</Count>,
            actions: (
              <>
                {onArchivedChange && (
                  <SegmentedControl
                    aria-label="Which projects"
                    value={archived ? "archived" : "active"}
                    onValueChange={(value) =>
                      onArchivedChange(value === "archived")
                    }
                    options={[
                      { value: "active", label: "Active" },
                      { value: "archived", label: "Archived" },
                    ]}
                  />
                )}
                {newProject}
              </>
            ),
            lede: archived
              ? "Archived projects keep their tickets, links and checkouts. Reactivate one to assign new work to it."
              : "A project is a repository on this computer. Tickets link to it, and the command line picks it from the folder you're in.",
          })}
        />
      </div>
      {loading && projects.length === 0 ? (
        <div
          className="project-skeleton"
          role="status"
          aria-label="Loading projects"
        >
          {[0, 1, 2].map((key) => (
            <Skeleton key={key} className="h-10" />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <EmptyState
          icon={<Folder aria-hidden />}
          title={emptyCopy("projects").title}
          description={emptyCopy("projects").sentence}
          action={newProject}
        />
      ) : (
        <>
          <ul className="project-list" aria-label="Projects">
            <Presence key={String(archived)} initial={false}>
              {shown.map((item, index) => {
                const changing = lifecycle.pending.has(item.id);
                const keepAction = (button: HTMLButtonElement | null) => {
                  if (button) rowActions.current.set(item.id, button);
                  else rowActions.current.delete(item.id);
                };
                const isOpen = expanded[item.id] ?? false;
                const checkouts = `project-${item.id}-checkouts`;
                return (
                  <m.li
                    key={item.id}
                    className="project-row"
                    data-open={isOpen || undefined}
                    data-archived={archived || undefined}
                    {...arrival(0, { space: true }, tokens)}
                    {...departure({ space: true }, tokens)}
                  >
                    <div {...enter(index + 1)}>
                      <div className="project-row-main">
                        <h2 className="project-row-heading">
                          <button
                            type="button"
                            className="project-row-toggle"
                            aria-expanded={isOpen}
                            disabled={changing}
                            aria-controls={checkouts}
                            onClick={() =>
                              setExpanded((old) => ({
                                ...old,
                                [item.id]: !isOpen,
                              }))
                            }
                          >
                            <ChevronRight
                              aria-hidden="true"
                              className="project-row-chevron"
                            />
                            <ProjectIcon
                              project={{ id: item.id, title: item.name }}
                              size={20}
                            />
                            <span className="project-row-text">
                              <span className="project-row-name">
                                {item.name}
                              </span>
                              <span className="project-row-meta">
                                {changing && !archived
                                  ? "Archiving…"
                                  : projectMeta(item, counts[item.id])}
                              </span>
                            </span>
                          </button>
                        </h2>
                        <span className="project-row-actions">
                          {onOpenTickets && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-label={`Open tickets of ${item.name}`}
                              disabled={changing}
                              onClick={() => onOpenTickets(item)}
                            >
                              Open tickets
                            </Button>
                          )}
                          {archived ? (
                            <Button
                              ref={keepAction}
                              type="button"
                              variant="outline"
                              size="sm"
                              className="min-w-32"
                              disabled={changing}
                              aria-label={`Reactivate ${item.name}`}
                              onClick={() => changeArchiveState(item)}
                            >
                              <ArchiveRestore aria-hidden />
                              {changing ? "Reactivating…" : "Reactivate"}
                            </Button>
                          ) : (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <IconButton
                                  ref={keepAction}
                                  disabled={changing}
                                  label={`Actions for ${item.name}`}
                                >
                                  <MoreHorizontal />
                                </IconButton>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  onSelect={() =>
                                    open({ kind: "edit", id: item.id })
                                  }
                                >
                                  <Pencil /> Edit project…
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onSelect={() => void copyId(item)}
                                >
                                  <Copy /> Copy project ID
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onSelect={() =>
                                    open({ kind: "checkout", id: item.id })
                                  }
                                >
                                  <Plus /> Register checkout…
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  onSelect={() => changeArchiveState(item)}
                                >
                                  <Archive /> Archive project
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </span>
                      </div>
                      <div
                        id={checkouts}
                        className="project-checkouts"
                        hidden={!isOpen}
                      >
                        {item.paths.length === 0 && archived ? (
                          <p className="project-checkouts-empty">
                            No checkouts.
                          </p>
                        ) : item.paths.length === 0 ? (
                          <p className="project-checkouts-empty">
                            No checkouts. Register one so the command line finds{" "}
                            {item.name} from its folder.{" "}
                            <Button
                              type="button"
                              variant="link"
                              size="inline"
                              disabled={changing}
                              onClick={() =>
                                open({ kind: "checkout", id: item.id })
                              }
                            >
                              Register checkout…
                            </Button>
                          </p>
                        ) : (
                          <ul
                            className="checkout-list"
                            aria-label={`Checkouts of ${item.name}`}
                          >
                            {item.paths.map((path) => (
                              <CheckoutRow
                                key={path}
                                path={path}
                                first={path === item.path}
                                disabled={changing}
                                {...(!archived && {
                                  onRemove: () =>
                                    void removeCheckout(item, path),
                                })}
                              />
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  </m.li>
                );
              })}
            </Presence>
          </ul>
          {shown.length === 0 && (
            <EmptyState
              icon={<Folder aria-hidden />}
              title={
                emptyCopy(archived ? "projects-archived" : "projects-active")
                  .title
              }
              description={
                emptyCopy(archived ? "projects-archived" : "projects-active")
                  .sentence
              }
            />
          )}
        </>
      )}
      {!archived && unassigned > 0 && onShowUnassigned && (
        <p className="projects-unassigned">
          {plural(unassigned, "ticket")} {unassigned === 1 ? "has" : "have"} no
          project.{" "}
          <Button
            type="button"
            variant="link"
            size="inline"
            onClick={onShowUnassigned}
          >
            Show {unassigned === 1 ? "it" : "them"}
          </Button>
        </p>
      )}
      <ProjectFormDialog
        open={
          dialog?.kind === "project" || (dialog?.kind === "edit" && !!editing)
        }
        {...(editing && { project: editing })}
        resolveReturnFocus={returnFocus}
        onOpenChange={(next) => !next && closeDialog()}
        onSaved={projectSaved}
        onExitComplete={() => {
          const projectId = sourceReview.current;
          sourceReview.current = null;
          if (
            projectId &&
            !closedForArchive &&
            !projects.find(({ id }) => id === projectId)?.archived
          )
            onConnectSource?.(projectId);
        }}
      />
      <DialogShell
        open={!!checkoutProject}
        resolveReturnFocus={returnFocus}
        onOpenChange={(next) => !next && closeDialog()}
        title="Register checkout"
        description={`Choose another folder where ${checkoutProject?.name ?? "this project"} is checked out.`}
        primaryLabel="Register checkout"
        busy={pending}
        blockedReason={
          blocked ??
          (!checkoutPath ? "Choose the checkout folder to continue." : null)
        }
        error={
          error && (
            <FailureAlert
              size="compact"
              failure={error}
              onRetry={() => void registerCheckout()}
            />
          )
        }
        onSubmit={() => void registerCheckout()}
      >
        <FolderPicker
          label="Folder"
          path={checkoutPath}
          title="Choose the checkout folder"
          onChoose={(path) =>
            checkoutProject &&
            setCheckoutDrafts((old) => ({
              ...old,
              [checkoutProject.id]: path,
            }))
          }
        />
      </DialogShell>
    </ManagementPage>
  );
}
