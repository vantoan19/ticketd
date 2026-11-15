import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Tooltip } from "@/components/ui/tooltip";
import { useEffect, useState } from "react";
import {
  Check,
  Copy,
  Folder,
  FolderOpen,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Item } from "@/components/ui/item";
import { DialogShell } from "@/components/ui/dialog-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { FailureAlert } from "@/components/ui/failure-alert";
import { Field, FieldLabel } from "@/components/ui/field";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { useCopy } from "@/components/ui/use-copy";
import { client, type Project } from "@/lib/api/client";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { workspaceClient } from "@/lib/api/workspace";
import { fileManagerName } from "@/lib/platform";
import { nameFromFolder } from "@/features/projects/paths";
import { ProjectIcon } from "@/features/projects/ProjectIcon";
import { PathText } from "@/features/projects/PathText";
import "./projects.css";
import { SectionHeader } from "@/components/ui/section-header";

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

/** "d5b4cc0e…669eae": the ends of an ID, enough to recognise it. */
function truncateId(id: string) {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}

function ticketsLabel(count: TicketCount | undefined) {
  if (!count) return "";
  const noun = count.total === 1 ? "ticket" : "tickets";
  return `${count.total} ${noun} · ${count.open} open`;
}

/** An icon button that copies text and announces it. */
function CopyIcon({ label, text }: { label: string; text: string }) {
  const { copied, error, copy } = useCopy();
  return (
    <>
      <IconButton
        type="button"
        label={label}
        onClick={() => void copy("text", text)}
      >
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      </IconButton>
      <span className="sr-only" role="status">
        {copied && "Copied"}
        {error && "Copy unavailable. Select the text."}
      </span>
    </>
  );
}

function CheckoutRow({
  project,
  path,
  first,
  confirming,
  pending,
  error,
  onAsk,
  onCancel,
  onConfirm,
}: {
  project: Project;
  path: string;
  first: boolean;
  confirming: boolean;
  pending: boolean;
  error: FailureDescription | null;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const manager = fileManagerName();
  const [revealError, setRevealError] = useState<FailureDescription | null>(
    null,
  );
  if (confirming)
    return (
      <div
        className="checkout-confirm"
        role="group"
        aria-label={`Remove checkout ${path}`}
      >
        <p>
          Remove <code>{path}</code> from {project.name}? The command line will
          no longer infer this project from that folder. The project and its
          tickets are unchanged.
        </p>
        {error && (
          <FailureAlert size="compact" failure={error} onRetry={onConfirm} />
        )}
        <div className="checkout-confirm-actions">
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={pending}
            onClick={onConfirm}
          >
            {pending ? "Removing…" : "Remove checkout"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={onCancel}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  return (
    <Item>
      <span className="checkout-text">
        <PathText path={path} />
        <span className="checkout-note">
          {first ? "First checkout" : "Checkout"}
          {revealError && ` · ${revealError.title}`}
        </span>
      </span>
      <CopyIcon label={`Copy checkout path ${path}`} text={path} />
      <IconButton
        type="button"
        label={`Show ${path} in ${manager}`}
        onClick={() =>
          void workspaceClient
            .reveal(path)
            .then(() => setRevealError(null))
            .catch((reason) =>
              setRevealError(describeFailure(reason, `show it in ${manager}`)),
            )
        }
      >
        <FolderOpen aria-hidden />
      </IconButton>
      {/* One action is a direct button, never a one-item menu. */}
      <IconButton
        type="button"
        label={`Remove checkout ${path}`}
        onClick={onAsk}
      >
        <Trash2 aria-hidden />
      </IconButton>
    </Item>
  );
}

/** Shows the chosen folder, or that none is chosen, beside the picker. */
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
        <Folder
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
        {/* PathText carries the full path in its own tooltip. */}
        <span className="folder-path" data-empty={!path}>
          {path ? <PathText path={path} /> : "No folder chosen"}
        </span>
        <Button type="button" variant="outline" size="sm" onClick={choose}>
          {path ? "Change…" : "Choose folder…"}
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
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  // Drafts survive closing a dialog; a successful save discards them.
  const [newPath, setNewPath] = useState("");
  const [newName, setNewName] = useState<string | undefined>(undefined);
  const [renames, setRenames] = useState<Record<string, string>>({});
  const [checkoutDrafts, setCheckoutDrafts] = useState<Record<string, string>>(
    {},
  );
  // A failed write: shown above the dialog footer, never on a valid field.
  const [error, setError] = useState<FailureDescription | null>(null);
  const [pending, setPending] = useState("");
  const [confirming, setConfirming] = useState<{
    id: string;
    path: string;
  } | null>(null);
  const [removeError, setRemoveError] = useState<FailureDescription | null>(
    null,
  );
  const [counts, setCounts] = useState<Record<string, TicketCount>>({});
  const [unassigned, setUnassigned] = useState(0);

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
  /** Runs a write, refreshes, and reports whether it all succeeded. */
  async function run(
    key: string,
    fn: () => Promise<unknown>,
    action: string,
    fail: (failure: FailureDescription | null) => void,
  ) {
    setPending(key);
    fail(null);
    try {
      await fn();
      await onChange();
      return true;
    } catch (reason) {
      fail(describeFailure(reason, action));
      return false;
    } finally {
      setPending("");
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
    const saved = await run(
      "save",
      () => client.createProject(newNameValue.trim(), newPath),
      "create the project",
      setError,
    );
    if (!saved) return;
    setNewPath("");
    setNewName(undefined);
    setDialog(null);
  }
  async function renameProject() {
    if (!renaming) return;
    const saved = await run(
      "save",
      () => client.editProject(renaming.id, renameValue.trim(), renaming.path),
      "rename the project",
      setError,
    );
    if (!saved) return;
    drop(setRenames, renaming.id);
    setDialog(null);
  }
  async function registerCheckout() {
    if (!checkoutProject) return;
    const saved = await run(
      "checkout",
      () => client.registerCheckout(checkoutProject.id, checkoutPath),
      "register the checkout",
      setError,
    );
    if (!saved) return;
    drop(setCheckoutDrafts, checkoutProject.id);
    setDialog(null);
  }
  async function removeCheckout(project: Project, path: string) {
    const removed = await run(
      "remove",
      () => client.removeCheckout(project.id, path),
      "remove the checkout",
      setRemoveError,
    );
    if (removed) setConfirming(null);
  }

  const newProject = (
    <Button type="button" size="sm" onClick={() => open({ kind: "project" })}>
      <Plus aria-hidden />
      New project
    </Button>
  );
  const saving = pending === "save" || pending === "checkout";

  return (
    <section className="projects-column" aria-label="Project management">
      <SectionHeader
        level={1}
        title="Projects"
        count={projects.length > 0 ? projects.length : undefined}
        actions={projects.length > 0 && newProject}
      />
      <p className="projects-description">
        A project is a repository. Its identity survives moves and renames, and
        each checkout lets the command line infer the project from the folder
        you are in.
      </p>
      {loading ? (
        <EmptyState
          size="inline"
          role="status"
          description="Loading projects…"
        />
      ) : projects.length === 0 ? (
        <EmptyState
          icon={<Folder aria-hidden />}
          title="No projects yet"
          description="Add a repository to link tickets to it and let the command line pick it from a registered checkout."
          action={newProject}
        />
      ) : (
        <ul className="projects-list" aria-label="Projects">
          {projects.map((item) => (
            <li key={item.id}>
              <Card asChild>
                <section aria-labelledby={`project-${item.id}-name`}>
                  <CardHeader asChild>
                    <div className="project-card-header">
                      <ProjectIcon
                        project={{ id: item.id, title: item.name }}
                        size={20}
                      />
                      <h2 id={`project-${item.id}-name`}>{item.name}</h2>
                      <span className="project-tickets">
                        {ticketsLabel(counts[item.id])}
                      </span>
                      <span className="projects-spacer" />
                      {onOpenTickets && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="project-open-tickets"
                          aria-label={`Open tickets of ${item.name}`}
                          onClick={() => onOpenTickets(item)}
                        >
                          Open tickets
                        </Button>
                      )}
                      <IconButton
                        type="button"
                        label={`Rename project ${item.name}`}
                        onClick={() => open({ kind: "rename", id: item.id })}
                      >
                        <Pencil aria-hidden />
                      </IconButton>
                    </div>
                  </CardHeader>
                  <CardBody asChild>
                    <div className="project-card-body">
                      <span className="project-label">Checkouts</span>
                      {item.paths.length === 0 ? (
                        <p className="settings-hint">
                          No registered checkouts. Register one so the command
                          line can infer {item.name} from its folder.
                        </p>
                      ) : (
                        <ul
                          className="checkout-list"
                          aria-label={`Checkouts of ${item.name}`}
                        >
                          {item.paths.map((path) => (
                            <li key={path}>
                              <CheckoutRow
                                project={item}
                                path={path}
                                first={path === item.path}
                                confirming={
                                  confirming?.id === item.id &&
                                  confirming.path === path
                                }
                                pending={pending === "remove"}
                                error={removeError}
                                onAsk={() => {
                                  setRemoveError(null);
                                  setConfirming({ id: item.id, path });
                                }}
                                onCancel={() => setConfirming(null)}
                                onConfirm={() =>
                                  void removeCheckout(item, path)
                                }
                              />
                            </li>
                          ))}
                        </ul>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="register-checkout"
                        aria-label={`Register checkout for ${item.name}`}
                        onClick={() => open({ kind: "checkout", id: item.id })}
                      >
                        <Plus aria-hidden />
                        Register checkout…
                      </Button>
                    </div>
                  </CardBody>
                  <CardFooter asChild>
                    <div className="project-card-footer">
                      <span>Project ID</span>
                      <Tooltip content={item.id}>
                        <code tabIndex={0}>{truncateId(item.id)}</code>
                      </Tooltip>
                      <CopyIcon
                        label={`Copy project ID of ${item.name}`}
                        text={item.id}
                      />
                      <span className="projects-spacer" />
                      <span>
                        Used by <code>ticketd list --project</code>
                      </span>
                    </div>
                  </CardFooter>
                </section>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {unassigned > 0 && onShowUnassigned && (
        <p className="projects-unassigned">
          {unassigned} {unassigned === 1 ? "ticket has" : "tickets have"} no
          project.{" "}
          <Button
            type="button"
            variant="link"
            size="sm"
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
        blockedReason={
          saving
            ? "Saving…"
            : !newPath
              ? "Choose a folder to continue"
              : !newNameValue.trim()
                ? "Enter a project name."
                : null
        }
        onSubmit={() => void createProject()}
      >
        <div className="project-form">
          <FolderPicker
            label="Repository folder"
            path={newPath}
            title="Choose the repository folder"
            hint="Choose it with the button. It becomes the first checkout."
            onChoose={setNewPath}
          />
          <Field>
            <FieldLabel htmlFor="project-name">Name</FieldLabel>
            <Input
              id="project-name"
              className="project-name-input"
              value={newNameValue}
              placeholder="Filled in from the folder name"
              autoComplete="off"
              onChange={(e) => setNewName(e.target.value)}
            />
          </Field>
          {error && (
            <FailureAlert
              size="compact"
              failure={error}
              onRetry={() => void createProject()}
            />
          )}
        </div>
      </DialogShell>
      <DialogShell
        open={!!renaming}
        onOpenChange={(next) => !next && setDialog(null)}
        title="Rename project"
        description="Its identity stays the same, and so do its tickets."
        primaryLabel="Save name"
        blockedReason={
          saving
            ? "Saving…"
            : !renameValue.trim()
              ? "Enter a project name."
              : null
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
        {error && (
          <FailureAlert
            size="compact"
            failure={error}
            onRetry={() => void renameProject()}
          />
        )}
      </DialogShell>
      <DialogShell
        open={!!checkoutProject}
        onOpenChange={(next) => !next && setDialog(null)}
        title="Register checkout"
        description={`Another folder where ${checkoutProject?.name ?? "this project"} lives on this computer.`}
        primaryLabel="Register checkout"
        blockedReason={
          saving
            ? "Saving…"
            : !checkoutPath
              ? "Choose the checkout folder to continue."
              : null
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
        {error && (
          <FailureAlert
            size="compact"
            failure={error}
            onRetry={() => void registerCheckout()}
          />
        )}
      </DialogShell>
    </section>
  );
}
