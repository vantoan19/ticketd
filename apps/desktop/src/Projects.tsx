import { useState, type FormEvent } from "react";
import { client, type Project, type Ticket } from "./client";

export function Projects({
  projects,
  filter,
  onFilter,
  onChange,
}: {
  projects: Project[];
  filter: string;
  onFilter: (filter: string) => void;
  onChange: () => Promise<void>;
}) {
  const [editing, setEditing] = useState("");
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  async function save(event: FormEvent) {
    event.preventDefault();
    try {
      if (editing) await client.editProject(editing, name, path);
      else await client.createProject(name, path);
      setEditing("");
      setName("");
      setPath("");
      setError("");
      await onChange();
    } catch (reason) {
      setError(String(reason));
    }
  }
  return (
    <nav aria-label="Projects" className="my-4">
      <h2 className="font-semibold">Projects</h2>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          aria-pressed={filter === "all"}
          onClick={() => onFilter("all")}
        >
          All tickets
        </button>
        <button
          type="button"
          aria-pressed={filter === "unlinked"}
          onClick={() => onFilter("unlinked")}
        >
          Unlinked
        </button>
        {projects.map((project) => (
          <span key={project.id}>
            <button
              type="button"
              aria-pressed={filter === project.id}
              onClick={() => onFilter(project.id)}
            >
              {project.name}
            </button>{" "}
            <button
              type="button"
              aria-label={`Edit ${project.name}`}
              onClick={() => {
                setEditing(project.id);
                setName(project.name);
                setPath(project.path);
              }}
            >
              Edit
            </button>
          </span>
        ))}
      </div>
      <form
        onSubmit={(event) => void save(event)}
        className="my-2 flex flex-wrap gap-2"
      >
        <label>
          Project name{" "}
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="border p-1"
          />
        </label>
        <label>
          Repository path{" "}
          <input
            required
            value={path}
            onChange={(e) => setPath(e.target.value)}
            className="border p-1"
          />
        </label>
        <button className="border px-2">
          {editing ? "Save project" : "Create project"}
        </button>
        {editing && (
          <button
            type="button"
            onClick={() => {
              setEditing("");
              setName("");
              setPath("");
            }}
          >
            Cancel
          </button>
        )}
      </form>
      {error && <p role="alert">{error}</p>}
    </nav>
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
