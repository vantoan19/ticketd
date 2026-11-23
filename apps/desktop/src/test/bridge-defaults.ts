const emptyPage = { items: [], next_offset: null };

/**
 * Quiet answers for the read commands every screen issues in the background,
 * so a test only spells out the data it cares about. A command not listed here
 * is recorded in `unknownCommands`; the test's `afterEach` asserts that list is
 * empty, so a changed bridge contract fails the test instead of rendering an
 * error state the test never looks at.
 */
export const unknownCommands: string[] = [];

export function bridgeDefault(
  command: string,
  args?: { id?: string; reference?: string },
): unknown {
  switch (command) {
    case "plugin:webview|set_webview_zoom":
      return null;
    case "attachment_upload_destination":
      return { kind: "local" };
    case "attachment_upload_limit":
      return 104857600;
    case "workspace_location":
      return "/tmp/ticketd-test/workspace.sqlite3";
    case "attachment_workspace_id":
      return "workspace-test";
    // Attachments settings reads it on open to gate the Google Drive tile.
    case "drive_configuration":
      return { configured: false, message: "" };
    case "latest_update":
      return null;
    case "document_context_links":
      return [[], []];
    case "automation_run_taken_over_in":
      return null;
    case "automation_agent_list":
    case "automation_list":
    case "automation_run_list":
    case "automation_run_list_all":
    case "automation_run_list_for_ticket":
    case "list_projects":
    case "list_plans":
    case "find_tickets":
    case "search_tickets":
    case "recent_documents":
    case "search_documents":
    case "all_documents":
    case "pinned_documents":
    case "activity_feed":
    case "ticket_history":
    case "list_evidence":
    case "ticket_attachments":
    case "list_attachments":
    case "search_attachments":
    case "ticket_backlinks":
    case "inbox":
    case "safety_backups":
    case "search_tags":
    case "source_conversation":
    case "sync_conflicts": // without sync: nothing to review, every file local
    case "sync_notices":
    case "attachment_availability":
    case "list_trash":
    case "source_configuration_summary":
    case "list_sources": // no built-in connector unless a test supplies one
      return [];
    case "count_tickets":
      return {
        total: 0,
        todo: 0,
        in_progress: 0,
        in_review: 0,
        done: 0,
        canceled: 0,
        duplicate: 0,
      };
    case "sync_status":
      // This Workspace does not sync unless a test says so.
      return {
        connection: "not_connected",
        account: null,
        folder: null,
        state: "saved_locally",
        last_synced_at: null,
        pending_uploads: [],
        attachment_downloads: { count: 0, bytes_left: 0 },
        needs_review: [],
        recovery: null,
        first_sync: null,
      };
    case "source_health":
      return { refreshing: false, sources: [] };
    case "preview_publication":
      // GitHub is not connected unless a test says so.
      return {
        reference: args?.reference ?? "",
        provider: "github",
        provider_name: "GitHub",
        destination: null,
        destinations: [],
        title: "",
        body: "",
        fingerprint: "0000000000000000",
        eligibility: {
          kind: "ineligible",
          reason: "source_not_connected",
          message: "connect GitHub first",
        },
        attempt: null,
      };
    case "count_by_source":
      return { all: 0, local: 0, providers: {} };
    case "sidebar_counts":
      return { unread_inbox: 0, ready: 0, in_progress: 0 };
    case "is_following":
      return false;
    case "reminder":
    case "last_backup":
    case "project_icon": // no favicon: the letter tile
      return null;
    case "workspace_info":
      return {
        path: "/data/ticketd/workspace.sqlite3",
        tickets: 0,
        projects: 0,
        documents: 0,
        active_plans: 0,
        size_bytes: 4096,
        format_version: 26,
      };
    case "check_cli":
      return {
        found: false,
        on_path: false,
        path: null,
        version: null,
        version_matches: null,
        workspace_path: null,
        workspace_matches: null,
        app_version: "0.1.0",
        app_workspace_path: null,
        suggested_directory: "~/.local/bin",
      };
    case "agent_skills":
      return [];
    case "show_plan":
      return {
        plan: { id: args?.id ?? "", name: "Plan", archived: false },
        members: [],
        counts: {
          todo: 0,
          in_progress: 0,
          in_review: 0,
          done: 0,
          canceled: 0,
          duplicate: 0,
        },
      };
    case "contextual_relationships":
      return {
        relationships: {
          parent: null,
          children: emptyPage,
          children_progress: { total: 0, done: 0 },
          prerequisites: emptyPage,
          blocking: emptyPage,
          related: emptyPage,
          discovered_while: emptyPage,
          discoveries: emptyPage,
          duplicate_of: null,
          duplicates: emptyPage,
        },
      };
    default:
      unknownCommands.push(command);
      throw new Error(`unexpected ${command}`);
  }
}
