import {
  Inbox,
  CircleDot,
  CheckCircle2,
  Trash2,
  Settings,
  Plus,
  Folder,
  Layers,
} from "lucide-react";
import { Sidebar } from "@/components/ui/sidebar";
import type { Project } from "@/lib/api/client";
import type { RefObject } from "react";

type View = "tickets" | "projects" | "efforts" | "settings";
export function WorkspaceSidebar({
  view,
  setView,
  filter,
  effort,
  status,
  availability,
  trash,
  projects,
  efforts,
  scope,
  setCreating,
  createTriggerRef,
}: {
  view: View;
  setView: (view: View) => void;
  filter: string;
  effort: string;
  status: string;
  availability: string;
  trash: boolean;
  projects: Project[];
  efforts: { id: string; name: string; archived: boolean }[];
  scope: (
    next: "all" | "ready" | "progress" | "trash",
    project?: string,
    effortId?: string,
  ) => void;
  setCreating: (value: boolean) => void;
  createTriggerRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <Sidebar collapsible="none" className="sidebar">
      <div className="brand">
        <span className="brand-mark">◈</span>
        <strong>ticketd</strong>
        <span className="brand-label">WORKSPACE</span>
      </div>
      <button
        className="new-ticket"
        onClick={(event) => {
          createTriggerRef.current = event.currentTarget;
          setView("tickets");
          setCreating(true);
        }}
      >
        <Plus size={16} /> New ticket
      </button>
      <nav aria-label="Workspace views" className="sidebar-nav">
        <button
          className={
            !trash &&
            filter === "all" &&
            !effort &&
            !status &&
            !availability &&
            view === "tickets"
              ? "active"
              : ""
          }
          onClick={() => scope("all")}
        >
          <Inbox size={16} /> All tickets
        </button>
        <button
          className={
            availability === "Ready" && view === "tickets" ? "active" : ""
          }
          onClick={() => scope("ready")}
        >
          <CheckCircle2 size={16} /> Ready
        </button>
        <button
          className={
            status === "In progress" && view === "tickets" ? "active" : ""
          }
          onClick={() => scope("progress")}
        >
          <CircleDot size={16} /> In progress
        </button>
        <button
          className={trash && view === "tickets" ? "active" : ""}
          onClick={() => scope("trash")}
        >
          <Trash2 size={16} /> Trash
        </button>
      </nav>
      <div className="sidebar-scroll">
        <div className="sidebar-heading">
          Projects{" "}
          <button
            aria-label="Manage projects"
            onClick={() => setView("projects")}
          >
            <Plus size={15} />
          </button>
        </div>
        <nav aria-label="Project scopes" className="sidebar-nav">
          <button
            className={
              filter === "unlinked" && view === "tickets" ? "active" : ""
            }
            onClick={() => scope("all", "unlinked")}
          >
            <Folder size={15} /> Unlinked
          </button>
          {projects.map((p) => (
            <button
              key={p.id}
              aria-pressed={filter === p.id && view === "tickets"}
              className={filter === p.id && view === "tickets" ? "active" : ""}
              onClick={() => scope("all", p.id)}
            >
              <Folder size={15} /> {p.name}
            </button>
          ))}
        </nav>
        <div className="sidebar-heading">
          Efforts{" "}
          <button
            aria-label="Manage Efforts"
            onClick={() => setView("efforts")}
          >
            <Plus size={15} />
          </button>
        </div>
        <nav aria-label="Effort scopes" className="sidebar-nav">
          {efforts
            .filter((e) => !e.archived)
            .map((e) => (
              <button
                key={e.id}
                className={
                  effort === e.id && view === "tickets" ? "active" : ""
                }
                onClick={() => scope("all", "all", e.id)}
              >
                <Layers size={15} /> {e.name}
              </button>
            ))}
        </nav>
      </div>
      <button className="settings-link" onClick={() => setView("settings")}>
        <Settings size={16} /> Workspace settings
      </button>
    </Sidebar>
  );
}
