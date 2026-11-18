import { ArrivingGroup } from "./ArrivingGroup";
import { FoldingGroup } from "./FoldingGroup";
import { useInboxAttention } from "@/features/tickets/use-inbox-attention";
import {
  Inbox,
  CirclePlay,
  ListTodo,
  MessagesSquare,
  Workflow,
  Trash2,
  Settings,
  SquarePen,
  Folder,
  Layers,
  FileText,
  Paperclip,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Rows3,
  Search,
  LoaderCircle,
} from "lucide-react";
import { plansClient, type PlanCounts } from "@/lib/api/plans";
import { PlanRing } from "@/features/plans/PlanProgress";
import { useWorkspaceChange } from "@/lib/workspace-change";
import { StatusIcon } from "@/features/tickets/StatusIcon";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CrossfadeText } from "@/components/ui/motion";
import { Tooltip } from "@/components/ui/tooltip";
import { IconButton } from "@/components/ui/icon-button";
import { StatusDot } from "@/components/ui/status-dot";
import type { Project } from "@/lib/api/client";
import type { SidebarCounts } from "@/lib/api/counts";
import {
  useContext,
  useEffect,
  useState,
  type ComponentType,
  type ReactNode,
  type RefObject,
} from "react";
import { ContextGraphNavigation } from "@/features/documents/navigation";
import { setPreference, usePreferences } from "@/lib/preferences";
import { useIsMobile } from "@/hooks/use-mobile";
import { SourceStatusFooter } from "@/components/layout/SourceStatusFooter";
import { useChatFeature } from "@/features/chats/use-chats";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { ariaKeyShortcuts, shortcutLabel } from "@/lib/shortcuts";

/** A secondary, trailing count; it is part of the row's name for assistive technology. */
function SidebarCount({ value }: { value: number }) {
  if (value === 0) return null;
  return (
    <>
      {" "}
      <span className="sidebar-count">
        <CrossfadeText>{String(value)}</CrossfadeText>
      </span>
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
  count?: string;
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

export type View =
  | "tickets"
  | "projects"
  | "plans"
  | "archived-plans"
  | "settings"
  | "inbox"
  | "documents"
  | "attachments"
  | "chats"
  | "automations";
export function WorkspaceSidebar({
  view: viewName,
  workspaceGraphOpen = false,
  onOpenPalette,
  createDisabledReason,
  counts,
  hasTickets,
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
  onOpenPalette: (origin: HTMLButtonElement) => void;
  createDisabledReason: string | null;
  /** Work-view counts; Projects and Plans carry none (DESIGN.md section 6). */
  counts: SidebarCounts | null;
  hasTickets: boolean;
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
  const change = useWorkspaceChange();
  const [planProgress, setPlanProgress] = useState<Record<string, PlanCounts>>(
    {},
  );
  useEffect(() => {
    let live = true;
    void Promise.all(
      plans
        .filter((plan) => !plan.archived)
        .map(async (plan) => {
          try {
            return [
              plan.id,
              (await plansClient.show(plan.id, 0, 0, false)).counts,
            ] as const;
          } catch {
            return null;
          }
        }),
    ).then((results) => {
      if (live)
        setPlanProgress(
          Object.fromEntries(results.filter((result) => result !== null)),
        );
    });
    return () => {
      live = false;
    };
  }, [plans, change]);
  const attention = useInboxAttention();
  const needsCount = attention?.needsCount ?? 0;
  const unread = (counts?.unread_inbox ?? 0) > 0;
  const inboxLabel = needsCount
    ? `Inbox, ${needsCount} ${needsCount === 1 ? "entry needs" : "entries need"} you`
    : unread
      ? `Inbox, ${counts?.unread_inbox} unread`
      : "Inbox";
  const chat = useChatFeature();
  // Waiting for the person (a request, uncertain delivery, an unseen failure),
  // then finished turns not yet seen. Working never counts.
  const waiting = chat.overview.needs_you;
  const unreadChats = chat.overview.unread;
  const working = chat.overview.working;
  const chatCounts = [
    waiting > 0 && `${waiting} waiting`,
    unreadChats > 0 && `${unreadChats} unread`,
    waiting === 0 && unreadChats === 0 && working > 0 && `${working} working`,
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
        icon: planProgress[e.id] ? (
          <PlanRing name={e.name} counts={planProgress[e.id]!} decorative />
        ) : (
          <Layers size={16} aria-hidden="true" />
        ),
        count: planProgress[e.id]
          ? `${planProgress[e.id]!.done}/${planProgress[e.id]!.todo + planProgress[e.id]!.in_progress + planProgress[e.id]!.in_review + planProgress[e.id]!.done}`
          : "",
        onSelect: () => scope("all", "all", e.id),
      })),
  ];
  // Ended as Needs attention, and not yet run again, taken over or dismissed.
  const runsWaiting = counts?.runs_needing_you ?? 0;
  const automationsLabel =
    runsWaiting > 0
      ? `Automations, ${runsWaiting} ${runsWaiting === 1 ? "run needs" : "runs need"} you`
      : "Automations";
  return (
    <Sidebar
      collapsible={isMobile ? "offcanvas" : "none"}
      className="sidebar"
      data-responsive-navigation="navigation"
      data-collapsed={collapsed || undefined}
      closeOnAction
    >
      <SidebarHeader
        className="sidebar-header"
        data-responsive-navigation="navigation"
      >
        <div className="sidebar-top" data-tauri-drag-region>
          <strong className="sidebar-wordmark" data-tauri-drag-region>
            ticketd
          </strong>
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
          <Tooltip
            content={createDisabledReason ?? "New ticket"}
            shortcut={shortcutLabel("new-ticket")}
          >
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="New ticket"
              aria-disabled={!!createDisabledReason}
              aria-description={createDisabledReason ?? undefined}
              aria-keyshortcuts={ariaKeyShortcuts("new-ticket")}
              onClick={(event) => {
                if (createDisabledReason) return;
                createTriggerRef.current = event.currentTarget;
                setCreating(true);
              }}
            >
              <SquarePen aria-hidden="true" />
            </Button>
          </Tooltip>
        </div>
        <Tooltip
          content="Search or jump to…"
          shortcut={shortcutLabel("command-palette")}
        >
          <Button
            variant="jump"
            aria-label="Search or jump to…"
            data-responsive-navigation="search"
            aria-keyshortcuts={ariaKeyShortcuts("command-palette")}
            onClick={(event) => onOpenPalette(event.currentTarget)}
          >
            <Search aria-hidden="true" />
            <span>Search or jump to…</span>
            <Kbd aria-hidden="true">{shortcutLabel("command-palette")}</Kbd>
          </Button>
        </Tooltip>
      </SidebarHeader>
      <SidebarContent
        className="sidebar-body"
        data-responsive-navigation="navigation"
      >
        <nav aria-label="Workspace views" className="sidebar-nav">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={view === "inbox"}
                tooltip={inboxLabel}
                aria-label={inboxLabel}
                onClick={() => setView("inbox")}
              >
                <Inbox size={16} /> <span className="sidebar-label">Inbox</span>
                {(needsCount > 0 || unread) && (
                  <span className="sidebar-count" aria-hidden="true">
                    <StatusDot
                      tone={needsCount ? "attention" : "unread"}
                      size={6}
                    />
                    {needsCount > 0 && (
                      <CrossfadeText>{String(needsCount)}</CrossfadeText>
                    )}
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
                <ListTodo size={16} />{" "}
                <span className="sidebar-label">All tickets</span>
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
                <CirclePlay size={16} />{" "}
                <span className="sidebar-label">Ready</span>
                {counts && <SidebarCount value={counts.ready} />}
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={navigation.kind === "progress" && view === "tickets"}
                tooltip="In progress"
                onClick={() => scope("progress")}
              >
                <StatusIcon status="In progress" decorative />{" "}
                <span className="sidebar-label">In progress</span>
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
                  <MessagesSquare size={16} />{" "}
                  <span className="sidebar-label">Chats</span>
                  {(waiting > 0 || working > 0 || unreadChats > 0) && (
                    <span className="sidebar-count" aria-hidden="true">
                      {waiting === 0 && working > 0 ? (
                        <LoaderCircle
                          className="sidebar-working animate-spin"
                          aria-hidden="true"
                        />
                      ) : (
                        <StatusDot
                          tone={waiting > 0 ? "attention" : "unread"}
                          size={6}
                        />
                      )}
                      {(waiting > 0 || working > 0) && (
                        <span>{waiting > 0 ? waiting : working}</span>
                      )}
                    </span>
                  )}
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
            {chat.enabled && (
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={view === "automations"}
                  tooltip={automationsLabel}
                  aria-label={automationsLabel}
                  onClick={() => setView("automations")}
                >
                  <Workflow size={16} />{" "}
                  <span className="sidebar-label">Automations</span>
                  {runsWaiting > 0 && (
                    <span className="sidebar-count" aria-hidden="true">
                      <StatusDot tone="attention" />
                      <span>{runsWaiting}</span>
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
        <span role="status" className="sr-only">
          {chat.enabled && runsWaiting > 0 ? automationsLabel : ""}
        </span>
        <div className="sidebar-scroll">
          <ArrivingGroup present={projects.length > 0 || hasTickets}>
            <SidebarGroup className="sidebar-group">
              <FoldingGroup
                collapsed={collapsed}
                rail={
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
                }
              >
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
                            <span className="sidebar-label">{entry.label}</span>
                          </Tooltip>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </nav>
              </FoldingGroup>
            </SidebarGroup>
          </ArrivingGroup>
          <ArrivingGroup present={plans.length > 0 || hasTickets}>
            <SidebarGroup className="sidebar-group">
              <FoldingGroup
                collapsed={collapsed}
                rail={
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
                }
              >
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
                          aria-label={entry.label}
                          aria-description={
                            entry.count ? `${entry.count} completed` : undefined
                          }
                          onClick={entry.onSelect}
                        >
                          {entry.icon}{" "}
                          <Tooltip content={entry.label} overflowOnly>
                            <span className="sidebar-label">{entry.label}</span>
                          </Tooltip>
                          {entry.count && (
                            <span className="sidebar-count">{entry.count}</span>
                          )}
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </nav>
              </FoldingGroup>
            </SidebarGroup>
          </ArrivingGroup>
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
                    <FileText size={16} />{" "}
                    <span className="sidebar-label">Documents</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={view === "attachments"}
                    tooltip="Attachments"
                    onClick={() => setView("attachments")}
                  >
                    <Paperclip size={16} />{" "}
                    <span className="sidebar-label">Attachments</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={workspaceGraphOpen}
                    tooltip="Workspace graph"
                    onClick={() => openGraph?.("__workspace__")}
                  >
                    <Network size={16} />{" "}
                    <span className="sidebar-label">Workspace graph</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </nav>
          </SidebarGroup>
        </div>
      </SidebarContent>
      <SidebarFooter
        className="sidebar-footer"
        data-responsive-navigation="navigation"
      >
        <SourceStatusFooter />
        <nav aria-label="Trash and settings" className="sidebar-footer-actions">
          <IconButton
            id="sidebar-settings"
            label="Settings"
            shortcut={shortcutLabel("go-settings")}
            aria-keyshortcuts={ariaKeyShortcuts("go-settings")}
            aria-current={view === "settings" ? "page" : undefined}
            onClick={() => setView("settings")}
          >
            <Settings aria-hidden="true" />
          </IconButton>
          <IconButton
            label="Trash"
            shortcut={shortcutLabel("go-trash")}
            aria-keyshortcuts={ariaKeyShortcuts("go-trash")}
            aria-current={
              navigation.kind === "trash" && view === "tickets"
                ? "page"
                : undefined
            }
            onClick={() => scope("trash")}
          >
            <Trash2 aria-hidden="true" />
          </IconButton>
        </nav>
      </SidebarFooter>
    </Sidebar>
  );
}
