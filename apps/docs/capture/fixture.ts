import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { bridgeDefault } from "../../desktop/src/test/bridge-defaults";
import type {
  AuthoredActivity,
  DependencyGraph,
  Evidence,
  FindFilter,
  Ticket,
} from "../../desktop/src/lib/api/client";
import type { LatestUpdate } from "../../desktop/src/lib/api/progress";
import type { Entry } from "../../desktop/src/lib/api/inbox";
import type { View } from "../../desktop/src/lib/api/plans";
import type { WorkspaceInfo } from "../../desktop/src/lib/api/workspace";
import type {
  Automation,
  AutomationAgent,
} from "../../desktop/src/features/automations/client";
import { featureRef } from "../src/demo/workspace";

interface Seed {
  info: WorkspaceInfo;
  tickets: { ticket: Ticket; latest_update: LatestUpdate | null }[];
  plan: View;
  spec: { id: string; title: string; body: string };
  inbox: Entry[];
  history: unknown[];
  activity: (
    | { type: "authored"; activity: AuthoredActivity }
    | { type: "automatic"; id: number }
  )[];
  evidence: Evidence[];
  context: { relationships: unknown };
  planGraph: DependencyGraph;
}
declare global {
  interface Window {
    captureWorkspace: Seed;
    captureAutomations: boolean;
  }
}
const workspace = window.captureWorkspace;
const tickets = workspace.tickets;
const plan = workspace.plan;
const hasFeature = (args: { reference?: string }) =>
  args.reference === featureRef;
const definitions: Pick<
  Automation,
  "id" | "name" | "trigger" | "steps" | "has_ticket"
>[] = [
  {
    id: "review-notice",
    name: "Review notification",
    trigger: { kind: "status_changed", from: null, to: "In review" },
    steps: [
      {
        id: "notify",
        kind: "notify",
        text: "A ticket is ready for review.",
        opens: "ticket",
      },
    ],
    has_ticket: true,
  },
  {
    id: "security-triage",
    name: "Triage security tickets",
    trigger: { kind: "ticket_created" },
    steps: [
      {
        id: "check",
        kind: "if",
        checks: [{ kind: "tag", tag: "security", has: true }],
        yes: [
          {
            id: "flag",
            kind: "change_ticket",
            change: { action: "add_tag", tag: "triage" },
          },
        ],
        no: [],
      },
    ],
    has_ticket: true,
  },
  {
    id: "weekly-review",
    name: "Weekly review",
    trigger: {
      kind: "schedule",
      schedule: { kind: "weekly", weekdays: ["mon"], time: "09:00" },
    },
    steps: [
      {
        id: "scan",
        kind: "run_agent",
        agent_id: "reviewer",
        execution_folder: "/workspace/api-rate-limits",
      },
      {
        id: "notify",
        kind: "notify",
        text: "The weekly review is ready.",
        opens: "run",
      },
    ],
    has_ticket: false,
  },
];
const rules: Automation[] = definitions.map((rule) => ({
  ...rule,
  enabled: true,
  arrived_off: false,
  conditions: [],
  problems: [],
}));
const reviewer: AutomationAgent = {
  id: "reviewer",
  name: "Review agent",
  harness: "codex",
  model: null,
  instructions: "Read the open review tickets and report what is waiting.",
  tools: {
    read_files: true,
    edit_files: false,
    run_commands: true,
    any_command: false,
    allowed_commands: ["ticketd list"],
    use_web: false,
  },
  turn_limit: 4,
  time_limit_minutes: 5,
  used_by: ["weekly-review"],
};
function matches(ticket: Ticket, filter?: Partial<FindFilter>) {
  return (
    (!filter?.status || ticket.status === filter.status) &&
    (!filter?.plan || ticket.plan_id === filter.plan) &&
    (!filter?.availability || ticket.availability === filter.availability) &&
    (!filter?.query || ticket.title.includes(filter.query))
  );
}
function counts(list: Ticket[]) {
  const count = (status: string) =>
    list.filter((t) => t.status === status).length;
  return {
    total: list.length,
    todo: count("Todo"),
    in_progress: count("In progress"),
    in_review: count("In review"),
    done: count("Done"),
    canceled: 0,
    duplicate: 0,
  };
}
type Args = {
  filter?: Partial<FindFilter>;
  id?: string;
  reference?: string;
  projection?: string;
  ids?: string[];
  offset?: number;
  limit?: number;
  unreadOnly?: boolean;
  references?: string[];
};
mockWindows("main");
mockIPC(
  (command, payload) => {
    const a = (payload ?? {}) as Args;
    const found = tickets.find((item) => item.ticket.reference === a.reference);
    const range = tickets.filter(
      ({ ticket }) =>
        matches(ticket, a.filter) && (!a.ids || a.ids.includes(ticket.id)),
    );
    const page = range.slice(
      a.filter?.offset ?? 0,
      (a.filter?.offset ?? 0) + (a.filter?.limit ?? 100),
    );
    switch (command) {
      case "draft_retentions":
        return [];
      case "draft_cutover_pending":
        return false;
      case "plugin:window|is_decorated":
        return true;
      case "plugin:window|inner_size":
        return {
          width: window.innerWidth * window.devicePixelRatio,
          height: window.innerHeight * window.devicePixelRatio,
        };
      case "plugin:window|scale_factor":
        return 2;
      case "updates_state":
        return {
          revision: 0,
          automatic: false,
          dismissed: false,
          install_on_quit: false,
          status: "unavailable",
        };
      case "workspace_change_token":
        return 1;
      case "list_plans":
        return [plan.plan];
      case "show_plan":
        return plan;
      case "plan_dependency_graph":
        return workspace.planGraph;
      case "show_ticket":
        return found?.ticket;
      case "count_tickets":
        return counts(range.map((row) => row.ticket));
      case "sidebar_counts":
        return {
          unread_inbox: workspace.inbox.length,
          ready: tickets.filter((t) => t.ticket.availability === "Ready")
            .length,
          in_progress: counts(tickets.map((t) => t.ticket)).in_progress,
        };
      case "count_by_source":
        return { all: tickets.length, local: tickets.length, providers: {} };
      case "find_tickets_with_updates":
        return a.projection
          ? { items: page.map((t) => t.ticket), omitted: false }
          : page;
      case "find_tickets":
      case "search_tickets":
        return page.map((row) => row.ticket);
      case "find_ticket_rows":
        return page.map(({ ticket, latest_update }) => ({
          ...ticket,
          latest_update,
          prerequisites: {
            total: ticket.prerequisites.length,
            unresolved: ticket.prerequisites.filter((p) => p.unresolved).length,
          },
        }));
      case "get_document":
      case "show_document":
        return workspace.spec;
      case "latest_update":
        return found?.latest_update ?? null;
      case "activity_feed":
        return hasFeature(a) ? workspace.activity : [];
      case "ticket_history":
        return hasFeature(a) ? workspace.history : [];
      case "list_evidence":
        return hasFeature(a) ? workspace.evidence : [];
      case "ticket_evidence_page": {
        const items = hasFeature(a)
          ? [...workspace.evidence]
              .reverse()
              .sort((a, b) => b.created_at.localeCompare(a.created_at))
          : [];
        const offset = a.offset ?? 0;
        return { items: items.slice(offset, offset + 50), total: items.length };
      }
      case "contextual_relationships":
        return hasFeature(a)
          ? { relationships: workspace.context.relationships }
          : bridgeDefault(command, a);
      case "is_following":
        return hasFeature(a);
      case "inbox":
        return workspace.inbox
          .filter((e) => !a.unreadOnly || !e.read)
          .slice(a.offset ?? 0, (a.offset ?? 0) + (a.limit ?? 50));
      case "automation_agent_list":
        return [reviewer];
      case "automation_list":
        return rules;
      case "automation_definition":
        return rules.find((r) => r.id === a.id);
      case "workspace_info":
        return workspace.info;
      case "plugin:window|is_maximized":
      case "plugin:window|is_fullscreen":
        return false;
      case "plugin:window|show":
      case "plugin:window|set_theme":
      case "plugin:window|set_background_color":
      case "plugin:webview|set_webview_background_color":
      case "plugin:event|emit_to":
      case "plugin:notification|register_listener":
        return null;
      case "chat_list":
      case "chat_sessions":
        return [];
      default:
        try {
          return bridgeDefault(command, a);
        } catch (error) {
          console.error("Unanswered capture read", command);
          throw error;
        }
    }
  },
  { shouldMockEvents: true },
);
