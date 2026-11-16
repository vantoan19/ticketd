import type { WorkspaceProblem } from "@/lib/workspace-state";

export const workspaceMessages: Record<WorkspaceProblem, string> = {
  workspace_read_only: "This workspace is read-only. Changes can't be saved.",
  workspace_locked:
    "Another ticketd operation is using this workspace. Changes can't be saved right now.",
  disk_full: "The disk is full. Changes can't be saved.",
  workspace_unreadable:
    "ticketd can't read this workspace file. Changes can't be saved.",
  drafts_unprotected:
    "Unsaved drafts aren't protected right now. Keep this window open.",
};
