import {
  Inbox,
  CircleDot,
  CirclePlay,
  ListTodo,
  Trash2,
  Settings,
  Settings2,
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
import { StatusDot } from "@/components/ui/status-dot";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Project } from "@/lib/api/client";
import type { RefObject } from "react";
import { useIsMobile } from "@/hooks/use-mobile";

type View = "tickets" | "projects" | "efforts" | "settings" | "inbox";
export function WorkspaceSidebar({
  view,
  unread,
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
  unread: boolean;
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
  const isMobile = useIsMobile();
  return (
    <Sidebar
      collapsible={isMobile ? "offcanvas" : "none"}
      className="sidebar"
      closeOnAction
    >
      <SidebarHeader className="sidebar-header">
        <div className="brand">
          <strong>ticketd</strong>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                className="new-ticket"
                variant="ghost"
                size="icon-sm"
                aria-label="New ticket"
                onClick={(event) => {
                  createTriggerRef.current = event.currentTarget;
                  setView("tickets");
                  setCreating(true);
                }}
              >
                <Plus />
              </Button>
            </TooltipTrigger>
            <TooltipContent>New ticket</TooltipContent>
          </Tooltip>
        </div>
      </SidebarHeader>
      <SidebarContent className="sidebar-body">
        <nav aria-label="Workspace views" className="sidebar-nav">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={view === "inbox"}
                aria-label={unread ? "Inbox, unread" : "Inbox"}
                onClick={() => setView("inbox")}
              >
                <Inbox size={16} /> Inbox
                {unread && <StatusDot tone="unread" className="ml-auto" />}
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={
                  navigation.kind === "all" &&
                  navigation.project === "all" &&
                  !navigation.effort &&
                  view === "tickets"
                }
                onClick={() => scope("all")}
              >
                <ListTodo size={16} /> All tickets
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={navigation.kind === "ready" && view === "tickets"}
                onClick={() => scope("ready")}
              >
                <CirclePlay size={16} /> Ready
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={navigation.kind === "progress" && view === "tickets"}
                onClick={() => scope("progress")}
              >
                <CircleDot size={16} /> In progress
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </nav>
        <span role="status" className="sr-only">
          {unread ? "Unread inbox items" : ""}
        </span>
        <div className="sidebar-scroll">
          <SidebarGroup className="sidebar-group">
            <div className="sidebar-heading">
              Projects{" "}
              <button
                aria-label="Manage projects"
                onClick={() => setView("projects")}
              >
                <Settings2 size={15} />
              </button>
            </div>
            <nav aria-label="Project scopes" className="sidebar-nav">
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={
                      navigation.project === "unlinked" && view === "tickets"
                    }
                    onClick={() => scope("all", "unlinked")}
                  >
                    <Folder size={15} /> Unlinked
                  </SidebarMenuButton>
                </SidebarMenuItem>
                {projects.map((p) => (
                  <SidebarMenuItem key={p.id}>
                    <SidebarMenuButton
                      isActive={
                        navigation.project === p.id && view === "tickets"
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
                <Settings2 size={15} />
              </button>
            </div>
            <nav aria-label="Effort scopes" className="sidebar-nav">
              <SidebarMenu>
                {efforts
                  .filter((e) => !e.archived)
                  .map((e) => (
                    <SidebarMenuItem key={e.id}>
                      <SidebarMenuButton
                        isActive={
                          navigation.effort === e.id && view === "tickets"
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
        <nav aria-label="Trash and settings" className="sidebar-nav">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={navigation.kind === "trash" && view === "tickets"}
                onClick={() => scope("trash")}
              >
                <Trash2 size={16} /> Trash
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={view === "settings"}
                onClick={() => setView("settings")}
              >
                <Settings size={16} /> Settings
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </nav>
      </SidebarFooter>
    </Sidebar>
  );
}
