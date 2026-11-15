import {
  Inbox,
  CircleDot,
  CirclePlay,
  ListTodo,
  MessagesSquare,
  Trash2,
  Settings,
  ChevronRight,
  SquarePen,
  ChevronDown,
  Lightbulb,
  Folder,
  Layers,
  Archive,
  FileText,
  Paperclip,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { IconButton } from "@/components/ui/icon-button";
import { StatusDot } from "@/components/ui/status-dot";
import type { Project } from "@/lib/api/client";
import type { SidebarCounts } from "@/lib/api/counts";
import { useContext, useRef, type ComponentType, type RefObject } from "react";
import { ContextGraphNavigation } from "@/features/documents/navigation";
import { setPreference, usePreferences } from "@/lib/preferences";
import { useIsMobile } from "@/hooks/use-mobile";
import { SourceStatusFooter } from "@/components/layout/SourceStatusFooter";
import { useChatFeature } from "@/features/chats/use-chats";
import { shortcutLabel } from "@/lib/shortcuts";

/** A secondary, trailing count; it is part of the row's name for assistive technology. */
function SidebarCount({ value }: { value: number }) {
  return (
    <>
      {" "}
      <span className="sidebar-count">{value}</span>
    </>
  );
}

/**
 * The heading's way to the page that manages the list below it. One action is
 * a direct button, never a one-item menu (DESIGN.md section 11).
 */
function ManageLink({
  label,
  onSelect,
}: {
  label: string;
  onSelect: () => void;
}) {
  return (
    <IconButton label={label} onClick={onSelect}>
      <ChevronRight aria-hidden="true" size={16} />
    </IconButton>
  );
}

type GroupEntry = {
  key: string;
  label: string;
  active: boolean;
  onSelect: () => void;
};

/**
 * A group on the folded rail: one icon that opens a menu of the group's
 * entries, so the rail holds a few fixed destinations and never scrolls.
 */
function GroupMenu({
  label,
  icon: Icon,
  entries,
  manage,
}: {
  label: string;
  icon: ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
  entries: GroupEntry[];
  manage: { label: string; onSelect: () => void };
}) {
  const current = entries.find((entry) => entry.active);
  const name = current ? `${label}, ${current.label}` : label;
  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <Tooltip content={name} side="right">
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton isActive={!!current} aria-label={name}>
              <Icon size={16} aria-hidden />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent side="right" align="start">
          {entries.map((entry) => (
            <DropdownMenuItem
              key={entry.key}
              onSelect={entry.onSelect}
              aria-current={entry.active ? "page" : undefined}
            >
              {entry.label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={manage.onSelect}>
            {manage.label}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}

type View =
  | "tickets"
  | "projects"
  | "plans"
  | "archived-plans"
  | "settings"
  | "inbox"
  | "documents"
  | "attachments"
  | "chats";
export function WorkspaceSidebar({
  view: viewName,
  workspaceGraphOpen = false,
  onCapture,
  onNewChat,
  counts,
  activePlanCount,
  setView,
  projects,
  plans,
  scope,
  setCreating,
  createTriggerRef,
  navigation,
  onError,
}: {
  navigation: {
    kind: "all" | "ready" | "progress" | "trash";
    project: string;
    plan: string;
  };
  view: View;
  /** The workspace graph covers the current view; only its entry is active. */
  workspaceGraphOpen?: boolean;
  onCapture: (from: HTMLElement | null) => void;
  /** Opens New Chat; only offered while Chat is turned on. */
  onNewChat?: () => void;
  counts: SidebarCounts | null;
  /** The open Plan's ticket count; Plans carry no counts of their own. */
  activePlanCount?: number | undefined;
  setView: (view: View) => void;
  projects: Project[];
  plans: { id: string; name: string; archived: boolean }[];
  scope: (
    next: "all" | "ready" | "progress" | "trash",
    project?: string,
    planId?: string,
  ) => void;
  setCreating: (value: boolean) => void;
  createTriggerRef: RefObject<HTMLButtonElement | null>;
  /** Says a sidebar choice could not be saved; "" once one saves again. */
  onError: (message: string) => void;
}) {
  // While the workspace graph is open no other entry reads as current.
  const view: View | null = workspaceGraphOpen ? null : viewName;
  const isMobile = useIsMobile();
  const { sidebarCollapsed } = usePreferences();
  // The sheet below 768px is never collapsed to icons.
  const collapsed = !isMobile && sidebarCollapsed;
  const newTrigger = useRef<HTMLButtonElement>(null);
  const moreTrigger = useRef<HTMLButtonElement>(null);
  // Choosing an item moves focus on its own; dismissing the menu returns it to New.
  const chose = useRef(false);
  const openGraph = useContext(ContextGraphNavigation);
  const unread = (counts?.unread_inbox ?? 0) > 0;
  const chat = useChatFeature();
  // Waiting for the person (a request, uncertain delivery, an unseen failure),
  // then finished turns not yet seen. Working never counts.
  const waiting = chat.overview.needs_you;
  const unreadChats = chat.overview.unread;
  const chatCounts = [
    waiting > 0 && `${waiting} waiting`,
    unreadChats > 0 && `${unreadChats} unread`,
  ].filter((part): part is string => Boolean(part));
  const chatsLabel = ["Chats", ...chatCounts].join(" · ");
  const chatsName = ["Chats", ...chatCounts].join(", ");
  const archivedPlans = plans.filter((e) => e.archived).length;
  return (
    <Sidebar
      collapsible={isMobile ? "offcanvas" : "none"}
      className="sidebar"
      data-collapsed={collapsed || undefined}
      closeOnAction
    >
      <SidebarHeader className="sidebar-header">
        <div className="brand">
          <strong>ticketd</strong>
          {!isMobile && (
            <IconButton
              label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              onClick={() =>
                onError(
                  setPreference("sidebarCollapsed", !collapsed)
                    ? ""
                    : "Couldn't save the sidebar state. This window can't store preferences right now.",
                )
              }
            >
              {collapsed ? (
                <PanelLeftOpen aria-hidden="true" />
              ) : (
                <PanelLeftClose aria-hidden="true" />
              )}
            </IconButton>
          )}
          {/* New ticket in one click (S1); the other ways to create sit
              behind the chevron beside it. */}
          <span className="new-ticket-split">
            <IconButton
              ref={newTrigger}
              className="new-ticket"
              label="New ticket"
              onClick={() => {
                createTriggerRef.current = newTrigger.current;
                // Opens over the current view, as Capture does.
                setCreating(true);
              }}
            >
              <SquarePen aria-hidden="true" />
            </IconButton>
            {chat.enabled && onNewChat ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton ref={moreTrigger} label="More ways to create">
                    <ChevronDown aria-hidden="true" />
                  </IconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  onCloseAutoFocus={(event) => {
                    if (chose.current) event.preventDefault();
                    chose.current = false;
                  }}
                >
                  <DropdownMenuItem
                    onSelect={() => {
                      chose.current = true;
                      onCapture(moreTrigger.current);
                    }}
                  >
                    <Lightbulb aria-hidden="true" />
                    Capture a thought
                    <DropdownMenuShortcut>
                      {shortcutLabel("capture")}
                    </DropdownMenuShortcut>
                  </DropdownMenuItem>
                  {onNewChat && (
                    <DropdownMenuItem
                      onSelect={() => {
                        chose.current = true;
                        onNewChat();
                      }}
                    >
                      <MessagesSquare aria-hidden="true" />
                      New Chat
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              // A one-item menu would be a detour (P3): Capture is direct.
              <IconButton
                ref={moreTrigger}
                label="Capture a thought"
                shortcut={shortcutLabel("capture")}
                onClick={() => onCapture(moreTrigger.current)}
              >
                <Lightbulb aria-hidden="true" />
              </IconButton>
            )}
          </span>
        </div>
      </SidebarHeader>
      <SidebarContent className="sidebar-body">
        <nav aria-label="Workspace views" className="sidebar-nav">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={view === "inbox"}
                tooltip={
                  unread ? `Inbox, ${counts?.unread_inbox} unread` : "Inbox"
                }
                aria-label={
                  unread ? `Inbox, ${counts?.unread_inbox} unread` : "Inbox"
                }
                onClick={() => setView("inbox")}
              >
                <Inbox size={16} /> Inbox
                {unread && (
                  <span className="sidebar-count" aria-hidden="true">
                    <StatusDot tone="unread" />
                    {counts?.unread_inbox}
                  </span>
                )}
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={
                  navigation.kind === "all" &&
                  navigation.project === "all" &&
                  !navigation.plan &&
                  view === "tickets"
                }
                tooltip="All tickets"
                onClick={() => scope("all")}
              >
                <ListTodo size={16} /> All tickets
                {counts?.total !== undefined && (
                  <SidebarCount value={counts.total} />
                )}
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={navigation.kind === "ready" && view === "tickets"}
                tooltip="Ready"
                onClick={() => scope("ready")}
              >
                <CirclePlay size={16} /> Ready
                {counts && <SidebarCount value={counts.ready} />}
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={navigation.kind === "progress" && view === "tickets"}
                tooltip="In progress"
                onClick={() => scope("progress")}
              >
                <CircleDot size={16} /> In progress
                {counts && <SidebarCount value={counts.in_progress} />}
              </SidebarMenuButton>
            </SidebarMenuItem>
            {chat.enabled && (
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={view === "chats"}
                  tooltip={chatsLabel}
                  aria-label={chatsName}
                  onClick={() => setView("chats")}
                >
                  <MessagesSquare size={16} /> Chats
                  {(waiting > 0 || unreadChats > 0) && (
                    <span className="sidebar-count" aria-hidden="true">
                      <StatusDot tone={waiting > 0 ? "attention" : "unread"} />
                      {waiting > 0 ? waiting : unreadChats}
                    </span>
                  )}
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
          </SidebarMenu>
        </nav>
        <span role="status" className="sr-only">
          {unread ? "Unread inbox items" : ""}
        </span>
        <span role="status" className="sr-only">
          {waiting > 0
            ? `${waiting} ${waiting === 1 ? "Chat" : "Chats"} waiting`
            : ""}
        </span>
        <div className="sidebar-scroll">
          <SidebarGroup className="sidebar-group">
            {collapsed ? (
              <>
                {/* One line on the rail between the ticket views and the rest. */}
                <div className="sidebar-heading" aria-hidden="true" />
                <nav aria-label="Projects" className="sidebar-nav">
                  <SidebarMenu>
                    <GroupMenu
                      label="Projects"
                      icon={Folder}
                      entries={[
                        ...projects.map((p) => ({
                          key: p.id,
                          label: p.name,
                          active:
                            navigation.project === p.id && view === "tickets",
                          onSelect: () => scope("all", p.id),
                        })),
                        {
                          key: "unlinked",
                          label: "No project",
                          active:
                            navigation.project === "unlinked" &&
                            view === "tickets",
                          onSelect: () => scope("all", "unlinked"),
                        },
                      ]}
                      manage={{
                        label: "All projects",
                        onSelect: () => setView("projects"),
                      }}
                    />
                  </SidebarMenu>
                </nav>
              </>
            ) : (
              <>
                <div
                  className="sidebar-heading"
                  data-active={view === "projects" || undefined}
                >
                  Projects{" "}
                  <ManageLink
                    label="All projects"
                    onSelect={() => setView("projects")}
                  />
                </div>
                <nav aria-label="Project scopes" className="sidebar-nav">
                  <SidebarMenu>
                    {projects.map((p) => (
                      <SidebarMenuItem key={p.id}>
                        <SidebarMenuButton
                          isActive={
                            navigation.project === p.id && view === "tickets"
                          }
                          tooltip={p.name}
                          onClick={() => scope("all", p.id)}
                        >
                          <Folder size={16} />{" "}
                          <Tooltip content={p.name} overflowOnly>
                            <span>{p.name}</span>
                          </Tooltip>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        isActive={
                          navigation.project === "unlinked" &&
                          view === "tickets"
                        }
                        tooltip="No project"
                        onClick={() => scope("all", "unlinked")}
                      >
                        {/* Dashed: not a project, the tickets that have none. */}
                        <Folder
                          size={16}
                          style={{ strokeDasharray: "2.5 2.5" }}
                        />{" "}
                        No project
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </nav>
              </>
            )}
          </SidebarGroup>
          <SidebarGroup className="sidebar-group">
            {!collapsed && <div className="sidebar-heading">Context</div>}
            <nav aria-label="Context" className="sidebar-nav">
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={view === "documents"}
                    tooltip="Documents"
                    onClick={() => setView("documents")}
                  >
                    <FileText size={16} /> Documents
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={view === "attachments"}
                    tooltip="Attachments"
                    onClick={() => setView("attachments")}
                  >
                    <Paperclip size={16} /> Attachments
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={workspaceGraphOpen}
                    tooltip="Workspace graph"
                    onClick={() => openGraph?.("__workspace__")}
                  >
                    <Network size={16} /> Workspace graph
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </nav>
          </SidebarGroup>
          <SidebarGroup className="sidebar-group">
            {collapsed ? (
              <nav aria-label="Plans" className="sidebar-nav">
                <SidebarMenu>
                  <GroupMenu
                    label="Plans"
                    icon={Layers}
                    entries={[
                      ...plans
                        .filter((e) => !e.archived)
                        .map((e) => ({
                          key: e.id,
                          label: e.name,
                          active:
                            navigation.plan === e.id && view === "tickets",
                          onSelect: () => scope("all", "all", e.id),
                        })),
                      {
                        key: "archived",
                        label: "Archived Plans",
                        active: view === "archived-plans",
                        onSelect: () => setView("archived-plans"),
                      },
                    ]}
                    manage={{
                      label: "All Plans",
                      onSelect: () => setView("plans"),
                    }}
                  />
                </SidebarMenu>
              </nav>
            ) : (
              <>
                <div className="sidebar-heading">
                  Plans{" "}
                  <ManageLink
                    label="All Plans"
                    onSelect={() => setView("plans")}
                  />
                </div>
                <nav aria-label="Plan scopes" className="sidebar-nav">
                  <SidebarMenu>
                    {plans
                      .filter((e) => !e.archived)
                      .map((e) => (
                        <SidebarMenuItem key={e.id}>
                          <SidebarMenuButton
                            isActive={
                              navigation.plan === e.id && view === "tickets"
                            }
                            tooltip={e.name}
                            onClick={() => scope("all", "all", e.id)}
                          >
                            <Layers size={16} />{" "}
                            <Tooltip content={e.name} overflowOnly>
                              <span>{e.name}</span>
                            </Tooltip>
                            {navigation.plan === e.id &&
                              view === "tickets" &&
                              activePlanCount !== undefined && (
                                <SidebarCount value={activePlanCount} />
                              )}
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      ))}
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        isActive={view === "archived-plans"}
                        tooltip="Archived Plans"
                        onClick={() => setView("archived-plans")}
                      >
                        <Archive size={16} /> Archived Plans
                        {archivedPlans > 0 && (
                          <SidebarCount value={archivedPlans} />
                        )}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </nav>
              </>
            )}
          </SidebarGroup>
        </div>
      </SidebarContent>
      <SidebarFooter className="sidebar-footer">
        <SourceStatusFooter />
        <nav aria-label="Trash and settings" className="sidebar-nav">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={navigation.kind === "trash" && view === "tickets"}
                tooltip="Trash"
                onClick={() => scope("trash")}
              >
                <Trash2 size={16} /> Trash
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                id="sidebar-settings"
                isActive={view === "settings"}
                tooltip="Settings"
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
