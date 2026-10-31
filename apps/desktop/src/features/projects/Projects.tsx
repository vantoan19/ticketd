import { useState, type FormEvent } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { client, type Project, type Ticket } from "@/lib/api/client";
import "../management.css";

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
  const [editing, setEditing] = useState("");
  const [drafts, setDrafts] = useState<
    Record<string, Partial<{ name: string; path: string }>>
  >({});
  const [checkout, setCheckout] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState("");
  const project = projects.find((item) => item.id === editing);
  const draft = {
    name: drafts[editing]?.name ?? project?.name ?? "",
    path: drafts[editing]?.path ?? project?.path ?? "",
  };
  const update = (patch: Partial<typeof draft>) =>
    setDrafts((old) => ({ ...old, [editing]: { ...old[editing], ...patch } }));
  const error = (key: string) =>
    errors[key] ? (
      <Alert variant="destructive" role="alert">
        <AlertDescription>{errors[key]}</AlertDescription>
      </Alert>
    ) : null;
  async function action(key: string, fn: () => Promise<void>) {
    setPending(key);
    setErrors((old) => ({ ...old, [key]: "" }));
    try {
      await fn();
      await onChange();
    } catch (reason) {
      setErrors((old) => ({ ...old, [key]: String(reason) }));
    } finally {
      setPending("");
    }
  }
  function save(event: FormEvent) {
    event.preventDefault();
    void action("save", async () => {
      if (editing) await client.editProject(editing, draft.name, draft.path);
      else await client.createProject(draft.name, draft.path);
      setDrafts((old) => {
        const next = { ...old };
        delete next[editing];
        return next;
      });
      setEditing("");
    });
  }
  return (
    <section className="management-content" aria-label="Project management">
      <section className="management-section">
        <h2>Repositories</h2>
        {loading ? (
          <p>Loading projects…</p>
        ) : projects.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyDescription>
                No projects yet. Add a repository to link it to tickets.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="management-list">
            {projects.map((item) => (
              <li key={item.id}>
                <span className="management-path">
                  <strong>{item.name}</strong>
                  <span title={item.path}>{item.path}</span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Edit ${item.name}`}
                  onClick={() => {
                    setEditing(item.id);
                    setErrors({});
                  }}
                >
                  Edit
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <form className="management-form" onSubmit={save}>
        <h2>{editing ? "Edit project" : "New project"}</h2>
        <p>
          A project represents a repository. Its identity remains the same when
          its path changes.
        </p>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="management-project-name">
              Project name
            </FieldLabel>
            <Input
              id="management-project-name"
              value={draft.name}
              onChange={(e) => update({ name: e.target.value })}
              required
            />
          </Field>
        </FieldGroup>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="management-repository-path">
              Repository path
            </FieldLabel>
            <Input
              id="management-repository-path"
              value={draft.path}
              onChange={(e) => update({ path: e.target.value })}
              required
            />
          </Field>
        </FieldGroup>
        {error("save")}
        <div className="management-actions">
          <Button disabled={!!pending}>
            {pending === "save"
              ? "Saving…"
              : editing
                ? "Save project"
                : "Create project"}
          </Button>
          {editing && (
            <Button
              type="button"
              variant="outline"
              disabled={!!pending}
              onClick={() => {
                setEditing("");
                setErrors({});
              }}
            >
              New project
            </Button>
          )}
        </div>
      </form>
      {project && (
        <section className="management-section">
          <h2>Registered checkouts</h2>
          <p>Paths registered for {project.name}.</p>
          {project.paths.length === 0 ? (
            <p>No registered checkouts.</p>
          ) : (
            <ul className="management-list">
              {project.paths.map((registered) => (
                <li key={registered}>
                  <span className="management-path-text" title={registered}>
                    {registered}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!!pending}
                    aria-label={`Remove checkout ${registered}`}
                    onClick={() =>
                      void action("remove", async () => {
                        await client.removeCheckout(editing, registered);
                      })
                    }
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {error("remove")}
          <form
            className="management-form"
            onSubmit={(e) => {
              e.preventDefault();
              void action("checkout", async () => {
                await client.registerCheckout(editing, checkout);
                setCheckout("");
              });
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="management-checkout-path">
                  Checkout path
                </FieldLabel>
                <Input
                  id="management-checkout-path"
                  value={checkout}
                  onChange={(e) => setCheckout(e.target.value)}
                  required
                />
              </Field>
            </FieldGroup>
            {error("checkout")}
            <div>
              <Button variant="outline" disabled={!!pending}>
                {pending === "checkout" ? "Registering…" : "Register checkout"}
              </Button>
            </div>
          </form>
        </section>
      )}
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
