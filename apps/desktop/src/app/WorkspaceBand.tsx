import { Button } from "@/components/ui/button";
import { FailureDetails } from "@/components/ui/failure-alert";
import { StatusDot } from "@/components/ui/status-dot";
import {
  clearWorkspaceFailure,
  useWorkspaceState,
  type WorkspaceProblem,
} from "@/lib/workspace-state";

const messages: Record<WorkspaceProblem, string> = {
  workspace_read_only: "This workspace is read-only. Changes can't be saved.",
  workspace_locked:
    "Another ticketd operation is using this workspace. Changes can't be saved right now.",
  disk_full: "The disk is full. Changes can't be saved.",
  workspace_unreadable:
    "ticketd can't read this workspace file. Changes can't be saved.",
  drafts_unprotected:
    "Unsaved drafts aren't protected right now. Keep this window open.",
};

/**
 * The workspace band (DESIGN.md section 12): one 40px line inside the top of
 * the content panel for workspace-level state only. At most one; it stays
 * until Retry succeeds. Everything else that fails for the same cause stays
 * quiet: editing controls are disabled with the reason as their tooltip.
 */
export function WorkspaceBand({ onRetry }: { onRetry: () => void }) {
  const state = useWorkspaceState();
  if (!state) return null;
  return (
    <div role="status" data-slot="workspace-band" className="workspace-band">
      <p className="workspace-band-message">
        <StatusDot tone="attention" size={10} />
        {messages[state.problem]}
      </p>
      <FailureDetails details={state.details} />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => {
          // Clear first: a write that still fails raises the band again.
          clearWorkspaceFailure();
          onRetry();
        }}
      >
        Retry
      </Button>
    </div>
  );
}
