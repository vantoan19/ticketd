import {
  Inbox,
  CircleDot,
  CirclePlay,
  ListTodo,
  MessagesSquare,
  MessageSquarePlus,
  Trash2,
  Settings,
  ChevronDown,
  SquarePen,
  NotebookPen,
  Folder,
  Layers,
  Archive,
  FileText,
  Paperclip,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Rows3,
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
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuShortcut,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { IconButton } from "@/components/ui/icon-button";
import { StatusDot } from "@/components/ui/status-dot";
import type { Project } from "@/lib/api/client";
import type { SidebarCounts } from "@/lib/api/counts";
import {
  useContext,
  useRef,
  type ComponentType,
  type ReactNode,
  type RefObject,
} from "react";
import { ContextGraphNavigation } from "@/features/documents/navigation";
import { setPreference, usePreferences } from "@/lib/preferences";
import { useIsMobile } from "@/hooks/use-mobile";
import { SourceStatusFooter } from "@/components/layout/SourceStatusFooter";
import { useChatFeature } from "@/features/chats/use-chats";
import { ariaKeyShortcuts, shortcutLabel } from "@/lib/shortcuts";

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
 * A group heading that is also the way to the page managing the group
 * (Projects, Plans): the nav row's hover and current fill on the 12px label,
 * with no change of padding (DESIGN.md section 6).
 */
function GroupHeading({
  label,
  current,
  onOpen,
}: {
  label: string;
  current: boolean;
  onOpen: () => void;
}) {
  return (
    <div className="sidebar-heading">
      <button
        type="button"
        className="sidebar-heading-link"
        aria-current={current ? "page" : undefined}
        onClick={onOpen}
      >
        {label}
      </button>
    </div>
  );
}

type GroupEntry = {
  key: string;
  label: string;
  active: boolean;
  /** The entry's own icon, as on its expanded row. */
  icon: ReactNode;
  onSelect: () => void;
};

/**
 * A group on the folded rail: one icon that opens a menu of the group's
 * entries, so the rail holds a few fixed destinations and never scrolls. The
 * menu is headed by the group's name, gives each entry its row's icon, marks
 * the current one with a check, and ends with the group's page.
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
  manage: { label: string; current: boolean; onSelect: () => void };
}) {
  const current = entries.find((entry) => entry.active);
  const name = current ? `${label}, ${current.label}` : label;
  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <Tooltip content={name} side="right">
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              isActive={!!current || manage.current}
              aria-label={name}
            >
              <Icon size={16} aria-hidden />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent side="right" align="start">
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={current?.key ?? ""}>
            {entries.map((entry) => (
              <DropdownMenuRadioItem
                key={entry.key}
                value={entry.key}
                onSelect={entry.onSelect}
              >
                {entry.icon}
                {entry.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={manage.onSelect}>
            <Rows3 aria-hidden />
            {manage.label}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}

/** The project glyph; dashed for "No project", the tickets that have none. */
const projectIcon = (unlinked = false) => (
  <Folder
    size={16}
    aria-hidden="true"
    {...(unlinked && { style: { strokeDasharray: "2.5 2.5" } })}
  />
);

/**
 * New ticket in one click, over the current view, with a chevron beside it
 * for the other ways to create: Capture a thought and, while Chat is on, New
 * Chat. The menu repeats New ticket so it always offers a choice.
 */
function CreateButtons({
  onNewTicket,
  onCapture,
  onNewChat,
}: {
  onNewTicket: (from: HTMLButtonElement | null) => void;
  onCapture: (from: HTMLElement | null) => void;
  onNewChat?: (() => void) | undefined;
}) {
  const newTrigger = useRef<HTMLButtonElement>(null);
  const moreTrigger = useRef<HTMLButtonElement>(null);
  // Choosing an item moves focus on its own; dismissing the menu returns it.
  const chose = useRef(false);
  return (
    <span className="new-ticket-split">
      <IconButton
        ref={newTrigger}

        label="New ticket"
        shortcut={shortcutLabel("new-ticket")}
        aria-keyshortcuts={ariaKeyShortcuts("new-ticket")}
        onClick={() => onNewTicket(newTrigger.current)}
      >
        <SquarePen aria-hidden="true" />
      </IconButton>
      {/* With Chat off the menu would hold only Capture and a repeat of New
          ticket, so the chevron's place is a direct Capture button (P3). */}
      {!onNewChat ? (
        <IconButton
          ref={moreTrigger}
          label="Capture a thought"
          shortcut={shortcutLabel("capture")}
          aria-keyshortcuts={ariaKeyShortcuts("capture")}
          onClick={() => onCapture(moreTrigger.current)}
        >
          <NotebookPen aria-hidden="true" />
        </IconButton>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton
              ref={moreTrigger}

              label="More ways to create"
            >
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
              aria-keyshortcuts={ariaKeyShortcuts("new-ticket")}
              onSelect={() => {
                chose.current = true;
                // After the menu has closed, so it cannot take focus back.
                window.setTimeout(() => onNewTicket(moreTrigger.current), 0);
              }}
            >
              <SquarePen aria-hidden />
              New ticket
              <DropdownMenuShortcut aria-hidden="true">
                {shortcutLabel("new-ticket")}
              </DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem
              aria-keyshortcuts={ariaKeyShortcuts("capture")}
              onSelect={() => {
                chose.current = true;
                onCapture(moreTrigger.current);
              }}
            >
              <NotebookPen aria-hidden />
              Capture a thought
              <DropdownMenuShortcut aria-hidden="true">
                {shortcutLabel("capture")}
              </DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                chose.current = true;
                onNewChat();
              }}
            >
              <MessageSquarePlus aria-hidden />
              New Chat
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </span>
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
  /** Work-view counts; Projects and Plans carry none (DESIGN.md section 6). */
  counts: SidebarCounts | null;
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
  const projectEntries: GroupEntry[] = [
    ...projects.map((p) => ({
      key: p.id,
      label: p.name,
      active: navigation.project === p.id && view === "tickets",
      icon: projectIcon(),
      onSelect: () => scope("all", p.id),
    })),
    {
      key: "unlinked",
      label: "No project",
      active: navigation.project === "unlinked" && view === "tickets",
      icon: projectIcon(true),
      onSelect: () => scope("all", "unlinked"),
    },
  ];
  const planEntries: GroupEntry[] = [
    ...plans
      .filter((e) => !e.archived)
      .map((e) => ({
        key: e.id,
        label: e.name,
        active: navigation.plan === e.id && view === "tickets",
        icon: <Layers size={16} aria-hidden="true" />,
        onSelect: () => scope("all", "all", e.id),
      })),
    {
      key: "archived",
      label: "Archived Plans",
      active: view === "archived-plans",
      icon: <Archive size={16} aria-hidden="true" />,
      onSelect: () => setView("archived-plans"),
    },
  ];
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
          <CreateButtons
            onNewTicket={(from) => {
              // Opens over the current view, as Capture does.
              createTriggerRef.current = from;
              setCreating(true);
            }}
            onCapture={onCapture}
            onNewChat={chat.enabled ? onNewChat : undefined}
          />
        </div>
      </SidebarHeader>
      <SidebarContent className="sidebar-body">
        <nav aria-label="Workspace views" className="sidebar-nav">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={view === "inbox"}
                tooltip={
                  unread ? `Inbox · ${counts?.unread_inbox} unread` : "Inbox"
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
              <nav aria-label="Projects" className="sidebar-nav">
                <SidebarMenu>
                  <GroupMenu
                    label="Projects"
                    icon={Folder}
                    entries={projectEntries}
                    manage={{
                      label: "All projects",
                      current: view === "projects",
                      onSelect: () => setView("projects"),
                    }}
                  />
                </SidebarMenu>
              </nav>
            ) : (
              <>
                <GroupHeading
                  label="Projects"
                  current={view === "projects"}
                  onOpen={() => setView("projects")}
                />
                <nav aria-label="Project scopes" className="sidebar-nav">
                  <SidebarMenu>
                    {projectEntries.map((entry) => (
                      <SidebarMenuItem key={entry.key}>
                        <SidebarMenuButton
                          isActive={entry.active}
                          onClick={entry.onSelect}
                        >
                          {entry.icon}{" "}
                          <Tooltip content={entry.label} overflowOnly>
                            <span>{entry.label}</span>
                          </Tooltip>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
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
                    entries={planEntries}
                    manage={{
                      label: "All Plans",
                      current: view === "plans",
                      onSelect: () => setView("plans"),
                    }}
                  />
                </SidebarMenu>
              </nav>
            ) : (
              <>
                <GroupHeading
                  label="Plans"
                  current={view === "plans"}
                  onOpen={() => setView("plans")}
                />
                <nav aria-label="Plan scopes" className="sidebar-nav">
                  <SidebarMenu>
                    {planEntries.map((entry) => (
                      <SidebarMenuItem key={entry.key}>
                        <SidebarMenuButton
                          isActive={entry.active}
                          onClick={entry.onSelect}
                        >
                          {entry.icon}{" "}
                          <Tooltip content={entry.label} overflowOnly>
                            <span>{entry.label}</span>
                          </Tooltip>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
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
