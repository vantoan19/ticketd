import { workspaceMessages } from "./workspace-messages";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { FailureDetails } from "@/components/ui/failure-alert";
import { Tooltip } from "@/components/ui/tooltip";
import { StatusDot } from "@/components/ui/status-dot";
import { useWorkspaceState } from "@/lib/workspace-state";

/**
 * The workspace band (DESIGN.md section 12): one 40px line inside the top of
 * the content panel for workspace-level state only. At most one; it stays
 * until Retry succeeds. Everything else that fails for the same cause stays
 * quiet: editing controls are disabled with the reason as their tooltip.
 */
export function WorkspaceBand({
  onRetry,
}: {
  onRetry: () => void | Promise<void>;
}) {
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const state = useWorkspaceState();
  if (!state) return null;
  return (
    <div role="status" data-slot="workspace-band" className="workspace-band">
      <p className="workspace-band-message">
        <StatusDot tone="attention" size={10} />
        <Tooltip content={workspaceMessages[state.problem]} overflowOnly>
          <span>{workspaceMessages[state.problem]}</span>
        </Tooltip>
      </p>
      <FailureDetails details={state.details} variant="popover" />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => {
          if (busy.current) return;
          busy.current = true;
          setPending(true);
          void Promise.resolve()
            .then(onRetry)
            .catch(() => {
              // The failure remains visible; the bridge reports an updated cause.
            })
            .finally(() => {
              busy.current = false;
              setPending(false);
            });
        }}
      >
        Retry
      </Button>
    </div>
  );
}
