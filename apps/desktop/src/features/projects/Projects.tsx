import { useEffect, useRef, useState } from "react";
import {
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { FailureAlert } from "@/components/ui/failure-alert";
import { Field, FieldLabel } from "@/components/ui/field";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { ManagementPage, PageHeader } from "@/components/ui/page-header";
import { PathText } from "@/components/ui/path-text";
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
import { nameFromFolder } from "@/lib/paths";
import { allowRemoval } from "@/lib/removal-guard";
import { fileManagerName } from "@/lib/platform";
import { ProjectIcon } from "@/features/projects/ProjectIcon";
import "./projects.css";

type OpenDialog =
  | { kind: "project" }
  | { kind: "rename"; id: string }
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
  onRemove,
}: {
  path: string;
  first: boolean;
  onRemove: () => void;
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
        <CopyButton label="Copy path" subject={path} text={path} />
        <IconButton label={`Show in ${manager}`} onClick={reveal}>
          <FolderOpen />
        </IconButton>
        <IconButton label="Remove checkout" onClick={onRemove}>
          <X />
        </IconButton>
      </span>
    </li>
  );
}

/** Shows the chosen folder, or that none is chosen, inside a field frame. */
function FolderPicker({
  path,
  label,
  title,
  hint,
  onChoose,
}: {
  path: string;
  label: string;
  title: string;
  hint?: string;
  onChoose: (path: string) => void;
}) {
  const [error, setError] = useState<FailureDescription | null>(null);
  async function choose() {
    try {
      const chosen = await workspaceClient.chooseFolder({ title });
      setError(null);
      if (chosen) onChoose(chosen);
    } catch (reason) {
      setError(describeFailure(reason, "open the folder picker"));
    }
  }
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <div className="folder-picker">
        <Folder aria-hidden="true" className="folder-picker-icon" />
        <span className="folder-path" data-empty={!path}>
          {path ? <PathText path={path} layout="inline" /> : "No folder chosen"}
        </span>
        <Button type="button" variant="outline" size="sm" onClick={choose}>
          {path ? "Change…" : "Choose…"}
        </Button>
      </div>
      {hint && <small className="folder-hint">{hint}</small>}
      {error && (
        <FailureAlert
          size="compact"
          failure={error}
          onRetry={() => void choose()}
        />
      )}
    </Field>
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
  loading,
  onChange,
  onOpenTickets,
  onShowUnassigned,
}: {
  projects: Project[];
  loading: boolean;
  onChange: () => Promise<void>;
  /** Shows that project's tickets. */
  onOpenTickets?: (project: Project) => void;
  /** Opens the tickets that belong to no project. */
  onShowUnassigned?: () => void;
}) {
  const statusLine = useStatusLine();
  const { copy } = useCopy();
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Drafts survive closing a dialog; a successful save discards them.
  const [newPath, setNewPath] = useState("");
  const [newName, setNewName] = useState<string | undefined>(undefined);
  const [renames, setRenames] = useState<Record<string, string>>({});
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

  const newNameValue = newName ?? nameFromFolder(newPath);
  const renaming =
    dialog?.kind === "rename"
      ? projects.find((item) => item.id === dialog.id)
      : undefined;
  const renameValue = renaming ? (renames[renaming.id] ?? renaming.name) : "";
  const checkoutProject =
    dialog?.kind === "checkout"
      ? projects.find((item) => item.id === dialog.id)
      : undefined;
  const checkoutPath = checkoutProject
    ? (checkoutDrafts[checkoutProject.id] ?? "")
    : "";

  function open(next: OpenDialog) {
    setError(null);
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
  async function createProject() {
    const saved = await save(
      () => client.createProject(newNameValue.trim(), newPath),
      "create the project",
    );
    if (!saved) return;
    setNewPath("");
    setNewName(undefined);
    setDialog(null);
  }
  async function renameProject() {
    if (!renaming) return;
    const saved = await save(
      () => client.editProject(renaming.id, renameValue.trim(), renaming.path),
      "rename the project",
    );
    if (!saved) return;
    drop(setRenames, renaming.id);
    setDialog(null);
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

  return (
    <ManagementPage aria-labelledby="projects-heading">
      <PageHeader
        title="Projects"
        titleId="projects-heading"
        {...(projects.length > 0 && {
          count: <Count>{projects.length}</Count>,
          actions: newProject,
        })}
        {...(projects.length > 0 && {
          lede: "A project is a repository on this computer. Tickets link to it, and the command line picks it from the folder you're in.",
        })}
      />
      {loading && projects.length === 0 ? (
        <div
          className="project-skeleton"
          role="status"
          aria-label="Loading projects"
        >
          {[0, 1, 2].map((key) => (
            <Skeleton key={key} className="project-skeleton-row" />
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
        <ul className="project-list" aria-label="Projects">
          {projects.map((item) => {
            const isOpen = expanded[item.id] ?? false;
            const checkouts = `project-${item.id}-checkouts`;
            return (
              <li
                key={item.id}
                className="project-row"
                data-open={isOpen || undefined}
              >
                <div className="project-row-main">
                  <h2 className="project-row-heading">
                    <button
                      type="button"
                      className="project-row-toggle"
                      aria-expanded={isOpen}
                      aria-controls={checkouts}
                      onClick={() =>
                        setExpanded((old) => ({ ...old, [item.id]: !isOpen }))
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
                        <span className="project-row-name">{item.name}</span>
                        <span className="project-row-meta">
                          {projectMeta(item, counts[item.id])}
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
                        onClick={() => onOpenTickets(item)}
                      >
                        Open tickets
                      </Button>
                    )}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <IconButton label={`Actions for ${item.name}`}>
                          <MoreHorizontal />
                        </IconButton>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onSelect={() => open({ kind: "rename", id: item.id })}
                        >
                          <Pencil /> Rename…
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => void copyId(item)}>
                          <Copy /> Copy project ID
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() =>
                            open({ kind: "checkout", id: item.id })
                          }
                        >
                          <Plus /> Register checkout…
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </span>
                </div>
                <div
                  id={checkouts}
                  className="project-checkouts"
                  hidden={!isOpen}
                >
                  {item.paths.length === 0 ? (
                    <p className="project-checkouts-empty">
                      No checkouts. Register one so the command line finds{" "}
                      {item.name} from its folder.{" "}
                      <Button
                        type="button"
                        variant="link"
                        size="inline"
                        onClick={() => open({ kind: "checkout", id: item.id })}
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
                          onRemove={() => void removeCheckout(item, path)}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {unassigned > 0 && onShowUnassigned && (
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
      <DialogShell
        open={dialog?.kind === "project"}
        onOpenChange={(next) => !next && setDialog(null)}
        title="New project"
        description="Start from the repository folder on this computer."
        primaryLabel="Create project"
        busy={pending}
        blockedReason={
          blocked ??
          (!newPath
            ? "Choose a folder to continue."
            : !newNameValue.trim()
              ? "Enter a project name."
              : null)
        }
        error={
          error && (
            <FailureAlert
              size="compact"
              failure={error}
              onRetry={() => void createProject()}
            />
          )
        }
        onSubmit={() => void createProject()}
      >
        <div className="project-form">
          <FolderPicker
            label="Repository folder"
            path={newPath}
            title="Choose the repository folder"
            hint="It becomes the project's first checkout."
            onChoose={setNewPath}
          />
          <Field>
            <FieldLabel htmlFor="project-name">Name</FieldLabel>
            <Input
              id="project-name"
              value={newNameValue}
              placeholder="e.g. Desktop app"
              autoComplete="off"
              onChange={(e) => setNewName(e.target.value)}
            />
          </Field>
        </div>
      </DialogShell>
      <DialogShell
        open={!!renaming}
        onOpenChange={(next) => !next && setDialog(null)}
        size="sm"
        title="Rename project"
        description="Its tickets and checkouts stay with it."
        primaryLabel="Save name"
        busy={pending}
        blockedReason={
          blocked ?? (!renameValue.trim() ? "Enter a project name." : null)
        }
        error={
          error && (
            <FailureAlert
              size="compact"
              failure={error}
              onRetry={() => void renameProject()}
            />
          )
        }
        onSubmit={() => void renameProject()}
      >
        <Field>
          <FieldLabel htmlFor="rename-name">Project name</FieldLabel>
          <Input
            id="rename-name"
            value={renameValue}
            autoComplete="off"
            onChange={(e) =>
              renaming &&
              setRenames((old) => ({ ...old, [renaming.id]: e.target.value }))
            }
          />
        </Field>
      </DialogShell>
      <DialogShell
        open={!!checkoutProject}
        onOpenChange={(next) => !next && setDialog(null)}
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
