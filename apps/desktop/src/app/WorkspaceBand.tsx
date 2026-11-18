import { workspaceMessages } from "./workspace-messages";
import { useRef, useState, type ReactNode } from "react";
import { m, useIsPresent } from "motion/react";
import { Expand, Presence } from "@/components/ui/motion";
import { blur, exitTransition } from "@/lib/motion-tokens";
import { useHeldExpand } from "@/components/ui/use-held-expand";
import { Button } from "@/components/ui/button";
import { FailureDetails } from "@/components/ui/failure-alert";
import { Tooltip } from "@/components/ui/tooltip";
import { StatusDot } from "@/components/ui/status-dot";
import { useWorkspaceState } from "@/lib/workspace-state";

/**
 * The space the band takes at the top of the content panel. `open` follows the
 * reservation (use-band-continuity), so it opens when the band may take layout
 * space and closes when that space is given back: height on the smooth spring,
 * everything below moving with it. It mounts closed and opens a frame later so
 * the first opening is seen, and stays mounted until the closing has finished.
 * A band that is already there when the window opens simply is.
 *
 * When the condition clears, the message fades out over `--dur-exit` while the
 * strip stays: the reservation, not the message, decides when the space goes.
 */
export function BandSlot({
  open,
  children,
}: {
  open: boolean;
  children: ReactNode;
}) {
  const { mounted, expanded } = useHeldExpand(open);
  if (!mounted) return null;
  return (
    <div className="workspace-band-slot" data-open={expanded}>
      <Expand open={expanded}>
        <div className="workspace-band-reserve">
          <Presence initial={false}>
            {children && (
              <m.div
                key="band"
                exit={{
                  opacity: 0,
                  filter: `blur(${blur("out")}px)`,
                  transition: exitTransition(),
                }}
              >
                {children}
              </m.div>
            )}
          </Presence>
        </div>
      </Expand>
    </div>
  );
}

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
  const current = useWorkspaceState();
  // While the band fades out (BandSlot's Presence) the condition has already
  // cleared; keep saying what it said until the band is gone. Anywhere else a
  // cleared condition leaves no band.
  const present = useIsPresent();
  const [last, setLast] = useState(current);
  if (current && current !== last) setLast(current);
  const state = current ?? (present ? null : last);
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
