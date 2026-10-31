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
import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import type { Project } from "@/lib/api/client";
import type { RefObject } from "react";

type View = "tickets" | "projects" | "efforts" | "settings";
export function WorkspaceSidebar({
  view,
  setView,
  projects,
  efforts,
  scope,
  setCreating,
  createTriggerRef,
  navigation,
}: {
  navigation: {
    kind: "all" | "ready" | "progress" | "trash";
    project: string;
    effort: string;
  };
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
      <SidebarHeader className="sidebar-header">
        <div className="brand">
          <span className="brand-mark">◈</span>
          <strong>ticketd</strong>
          <span className="brand-label">WORKSPACE</span>
        </div>
        <Button
          className="new-ticket"
          onClick={(event) => {
            createTriggerRef.current = event.currentTarget;
            setView("tickets");
            setCreating(true);
          }}
        >
          <Plus size={16} /> New ticket
        </Button>
      </SidebarHeader>
      <SidebarContent className="sidebar-body">
        <nav aria-label="Workspace views" className="sidebar-nav">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                className={
                  navigation.kind === "all" &&
                  navigation.project === "all" &&
                  !navigation.effort &&
                  view === "tickets"
                    ? "active"
                    : ""
                }
                onClick={() => scope("all")}
              >
                <Inbox size={16} /> All tickets
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                className={
                  navigation.kind === "ready" && view === "tickets"
                    ? "active"
                    : ""
                }
                onClick={() => scope("ready")}
              >
                <CheckCircle2 size={16} /> Ready
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                className={
                  navigation.kind === "progress" && view === "tickets"
                    ? "active"
                    : ""
                }
                onClick={() => scope("progress")}
              >
                <CircleDot size={16} /> In progress
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                className={
                  navigation.kind === "trash" && view === "tickets"
                    ? "active"
                    : ""
                }
                onClick={() => scope("trash")}
              >
                <Trash2 size={16} /> Trash
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </nav>
        <div className="sidebar-scroll">
          <SidebarGroup className="sidebar-group">
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
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    className={
                      navigation.project === "unlinked" && view === "tickets"
                        ? "active"
                        : ""
                    }
                    onClick={() => scope("all", "unlinked")}
                  >
                    <Folder size={15} /> Unlinked
                  </SidebarMenuButton>
                </SidebarMenuItem>
                {projects.map((p) => (
                  <SidebarMenuItem key={p.id}>
                    <SidebarMenuButton
                      aria-pressed={
                        navigation.project === p.id && view === "tickets"
                      }
                      className={
                        navigation.project === p.id && view === "tickets"
                          ? "active"
                          : ""
                      }
                      onClick={() => scope("all", p.id)}
                    >
                      <Folder size={15} /> {p.name}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </nav>
          </SidebarGroup>
          <SidebarGroup className="sidebar-group">
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
              <SidebarMenu>
                {efforts
                  .filter((e) => !e.archived)
                  .map((e) => (
                    <SidebarMenuItem key={e.id}>
                      <SidebarMenuButton
                        className={
                          navigation.effort === e.id && view === "tickets"
                            ? "active"
                            : ""
                        }
                        onClick={() => scope("all", "all", e.id)}
                      >
                        <Layers size={15} /> {e.name}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
              </SidebarMenu>
            </nav>
          </SidebarGroup>
        </div>
      </SidebarContent>
      <SidebarFooter className="sidebar-footer">
        <button className="settings-link" onClick={() => setView("settings")}>
          <Settings size={16} /> Workspace settings
        </button>
      </SidebarFooter>
    </Sidebar>
  );
}
