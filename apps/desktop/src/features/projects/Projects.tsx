import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
} from "@/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { client, type Project, type Ticket } from "@/lib/api/client";
import { SettingsCard } from "@/features/settings/SettingsCard";
import { CopyButton } from "@/features/projects/CopyButton";
import { FormDialog } from "@/features/projects/FormDialog";
import "../management.css";
import "./projects.css";

type Draft = { name: string; path: string };
type OpenDialog =
  { kind: "project"; editing: string } | { kind: "checkout"; id: string };

/** The draft key for a project that does not exist yet. */
const NEW = "";

/** The message for a blank field, shown once a save was attempted. */
function required(value: string, what: string) {
  return value.trim() ? "" : `Enter ${what}.`;
}

function CheckoutRow({
  project,
  path,
  confirming,
  pending,
  error,
  onAsk,
  onCancel,
  onConfirm,
}: {
  project: Project;
  path: string;
  confirming: boolean;
  pending: boolean;
  error: string;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
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
        {error && <FieldError>{error}</FieldError>}
        <div className="settings-actions">
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
    <div className="checkout-row">
      <code>{path}</code>
      <CopyButton label={`checkout path ${path}`} text={path} />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`Remove checkout ${path}`}
        onClick={onAsk}
      >
        Remove
      </Button>
    </div>
  );
}

export function Projects({
  projects,
  loading,
  onChange,
}: {
  projects: Project[];
  loading: boolean;
  filter: string;
  onFilter: (filter: string) => void;
  onChange: () => Promise<void>;
}) {
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  // Drafts survive closing a dialog with Escape; Cancel discards them.
  const [drafts, setDrafts] = useState<Record<string, Partial<Draft>>>({});
  const [checkoutDrafts, setCheckoutDrafts] = useState<Record<string, string>>(
    {},
  );
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState("");
  const [confirming, setConfirming] = useState<{
    id: string;
    path: string;
  } | null>(null);
  const [removeError, setRemoveError] = useState("");

  const editing = dialog?.kind === "project" ? dialog.editing : NEW;
  const editedProject = projects.find((item) => item.id === editing);
  const draft: Draft = {
    name: drafts[editing]?.name ?? editedProject?.name ?? "",
    path: drafts[editing]?.path ?? editedProject?.path ?? "",
  };
  const update = (patch: Partial<Draft>) =>
    setDrafts((old) => ({ ...old, [editing]: { ...old[editing], ...patch } }));
  const nameError = attempted ? required(draft.name, "a project name") : "";
  const pathError = attempted ? required(draft.path, "a repository path") : "";

  const checkoutProject =
    dialog?.kind === "checkout"
      ? projects.find((item) => item.id === dialog.id)
      : undefined;
  const checkoutPath = checkoutProject
    ? (checkoutDrafts[checkoutProject.id] ?? "")
    : "";
  const checkoutError = attempted
    ? required(checkoutPath, "a checkout path")
    : "";

  function open(next: OpenDialog) {
    setAttempted(false);
    setError("");
    setDialog(next);
  }
  /** Runs a write, refreshes, and reports whether it all succeeded. */
  async function run(
    key: string,
    fn: () => Promise<unknown>,
    fail: (message: string) => void,
  ) {
    setPending(key);
    try {
      await fn();
      await onChange();
      return true;
    } catch (reason) {
      fail(String(reason));
      return false;
    } finally {
      setPending("");
    }
  }
  function discard(key: string) {
    setDrafts((old) => {
      const next = { ...old };
      delete next[key];
      return next;
    });
  }
  function discardCheckout(id: string) {
    setCheckoutDrafts((old) => {
      const next = { ...old };
      delete next[id];
      return next;
    });
  }
  async function saveProject() {
    setAttempted(true);
    const name = draft.name.trim();
    const path = draft.path.trim();
    if (!name || !path) return;
    const saved = await run(
      "save",
      () =>
        editing
          ? client.editProject(editing, name, path)
          : client.createProject(name, path),
      setError,
    );
    if (!saved) return;
    discard(editing);
    setDialog(null);
  }
  async function registerCheckout() {
    if (!checkoutProject) return;
    setAttempted(true);
    const path = checkoutPath.trim();
    if (!path) return;
    const saved = await run(
      "checkout",
      () => client.registerCheckout(checkoutProject.id, path),
      setError,
    );
    if (!saved) return;
    discardCheckout(checkoutProject.id);
    setDialog(null);
  }
  async function removeCheckout(project: Project, path: string) {
    setRemoveError("");
    const removed = await run(
      "remove",
      () => client.removeCheckout(project.id, path),
      setRemoveError,
    );
    if (removed) setConfirming(null);
  }

  const newProject = (
    <Button
      type="button"
      onClick={() => open({ kind: "project", editing: NEW })}
    >
      <Plus aria-hidden />
      New project
    </Button>
  );

  return (
    <section className="projects-column" aria-label="Project management">
      <div className="projects-heading">
        <div>
          <h1>Projects</h1>
          <p>
            A project is a repository whose identity survives moves and renames.
            Registered checkouts let the command line infer the project from the
            folder you are in.
          </p>
        </div>
        {projects.length > 0 && newProject}
      </div>
      {loading ? (
        <p className="projects-empty settings-hint">Loading projects…</p>
      ) : projects.length === 0 ? (
        <Empty className="projects-empty">
          <EmptyHeader>
            <EmptyDescription>
              No projects yet. Add a repository to link tickets to it and let
              the command line pick it from a registered checkout.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>{newProject}</EmptyContent>
        </Empty>
      ) : (
        <ul className="projects-list" aria-label="Projects">
          {projects.map((item) => (
            <li key={item.id}>
              <SettingsCard
                id={`project-${item.id}`}
                title={item.name}
                actions={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`Edit ${item.name}`}
                    onClick={() => open({ kind: "project", editing: item.id })}
                  >
                    Edit
                  </Button>
                }
              >
                <div className="project-id">
                  <span className="settings-hint">Project ID</span>
                  <code>{item.id}</code>
                  <CopyButton
                    label={`project ID of ${item.name}`}
                    text={item.id}
                  />
                </div>
                <div className="checkouts-header">
                  <h3>Registered checkouts</h3>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`Register checkout for ${item.name}`}
                    onClick={() => open({ kind: "checkout", id: item.id })}
                  >
                    Register checkout
                  </Button>
                </div>
                {item.paths.length === 0 ? (
                  <p className="settings-hint">
                    No registered checkouts. Register one so the command line
                    can infer {item.name} from its folder.
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
                          confirming={
                            confirming?.id === item.id &&
                            confirming.path === path
                          }
                          pending={pending === "remove"}
                          error={removeError}
                          onAsk={() => {
                            setRemoveError("");
                            setConfirming({ id: item.id, path });
                          }}
                          onCancel={() => setConfirming(null)}
                          onConfirm={() => void removeCheckout(item, path)}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </SettingsCard>
            </li>
          ))}
        </ul>
      )}
      <FormDialog
        open={
          dialog?.kind === "project" && (editing === NEW || !!editedProject)
        }
        onOpenChange={(next) => !next && setDialog(null)}
        title={editing ? "Edit project" : "New project"}
        description={
          editing
            ? "Its identity stays the same, and so do its tickets."
            : "A project represents a repository."
        }
        submitLabel={editing ? "Save project" : "Create project"}
        pending={pending === "save"}
        error={error}
        onSubmit={() => void saveProject()}
        onCancel={() => {
          discard(editing);
          setDialog(null);
        }}
      >
        <FieldGroup>
          <Field data-invalid={!!nameError}>
            <FieldLabel htmlFor="project-name">Project name</FieldLabel>
            <Input
              id="project-name"
              value={draft.name}
              autoComplete="off"
              aria-invalid={!!nameError}
              aria-describedby={nameError ? "project-name-error" : undefined}
              onChange={(e) => update({ name: e.target.value })}
            />
            <FieldError id="project-name-error">{nameError}</FieldError>
          </Field>
          <Field data-invalid={!!pathError}>
            <FieldLabel htmlFor="project-path">Repository path</FieldLabel>
            <Input
              id="project-path"
              value={draft.path}
              autoComplete="off"
              aria-invalid={!!pathError}
              aria-describedby={
                pathError ? "project-path-error" : "project-path-hint"
              }
              onChange={(e) => update({ path: e.target.value })}
            />
            {pathError ? (
              <FieldError id="project-path-error">{pathError}</FieldError>
            ) : (
              <FieldDescription id="project-path-hint">
                {editing
                  ? "Changing it registers the new folder as a checkout and replaces the old repository path."
                  : "The folder of a checkout. It becomes the first registered checkout."}
              </FieldDescription>
            )}
          </Field>
        </FieldGroup>
      </FormDialog>
      <FormDialog
        open={!!checkoutProject}
        onOpenChange={(next) => !next && setDialog(null)}
        title="Register checkout"
        description={`Another folder where ${checkoutProject?.name ?? "this project"} lives on this computer.`}
        submitLabel="Register checkout"
        pending={pending === "checkout"}
        error={error}
        onSubmit={() => void registerCheckout()}
        onCancel={() => {
          if (checkoutProject) discardCheckout(checkoutProject.id);
          setDialog(null);
        }}
      >
        <FieldGroup>
          <Field data-invalid={!!checkoutError}>
            <FieldLabel htmlFor="checkout-path">Checkout path</FieldLabel>
            <Input
              id="checkout-path"
              value={checkoutPath}
              autoComplete="off"
              aria-invalid={!!checkoutError}
              aria-describedby={
                checkoutError ? "checkout-path-error" : undefined
              }
              onChange={(e) =>
                checkoutProject &&
                setCheckoutDrafts((old) => ({
                  ...old,
                  [checkoutProject.id]: e.target.value,
                }))
              }
            />
            <FieldError id="checkout-path-error">{checkoutError}</FieldError>
          </Field>
        </FieldGroup>
      </FormDialog>
    </section>
  );
}

export function TicketProject({
  ticket,
  projects,
  onSaved,
}: {
  ticket: Ticket;
  projects: Project[];
  onSaved: (ticket: Ticket) => void;
}) {
  const [error, setError] = useState("");
  async function change(project_id: string | null) {
    try {
      onSaved(await client.changeTicket(ticket.reference, { project_id }));
      setError("");
    } catch (reason) {
      setError(String(reason));
    }
  }
  return (
    <label className="block mt-3">
      Project{" "}
      <select
        value={ticket.project_id ?? ""}
        onChange={(e) => void change(e.target.value || null)}
        className="border p-1"
      >
        <option value="">Unlinked</option>
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
      {error && <span role="alert">{error}</span>}
    </label>
  );
}
