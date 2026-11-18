// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BandSlot, WorkspaceBand } from "@/app/WorkspaceBand";
import { MotionProvider } from "@/components/ui/motion";
import { frames, freezeMotionClock } from "@/test/motion-clock";
import { applyTokens, rootTokens } from "@/test/motion-tokens";
import {
  clearWorkspaceFailure,
  reportWorkspaceFailure,
  useWorkspaceState,
} from "@/lib/workspace-state";

// When the workspace condition clears, the band's message fades out over
// `--dur-exit` (DESIGN.md section 12). The strip that holds its place while the
// pointer is in the pane stays as it is.

const EXIT_MS = 150;
let restoreTokens: () => void;
let clock: ReturnType<typeof freezeMotionClock>;
beforeEach(() => {
  restoreTokens = applyTokens(rootTokens);
  clock = freezeMotionClock();
});
afterEach(() => {
  act(() => clearWorkspaceFailure());
  cleanup();
  clock.restore();
  restoreTokens();
});

function Band() {
  const state = useWorkspaceState();
  return (
    <MotionProvider>
      <BandSlot open>
        {state ? <WorkspaceBand onRetry={() => {}} /> : null}
      </BandSlot>
    </MotionProvider>
  );
}

const message = /read-only/i;

it("the message fades out over the exit time instead of vanishing at once", async () => {
  render(<Band />);
  act(() => void reportWorkspaceFailure("workspace_read_only", "locked"));
  await frames();
  await clock.advance(1000);
  expect(screen.queryAllByText(message).length).toBeGreaterThan(0);

  act(() => clearWorkspaceFailure());
  await frames();
  // Still on screen, mid-fade: nothing has been taken away yet.
  expect(screen.queryAllByText(message).length).toBeGreaterThan(0);
  await clock.advance(EXIT_MS / 2);
  expect(screen.queryAllByText(message).length).toBeGreaterThan(0);
  await clock.advance(EXIT_MS);
  expect(screen.queryAllByText(message)).toEqual([]);
});

it("the strip stays open, empty, once the message has gone", async () => {
  const { container } = render(<Band />);
  act(() => void reportWorkspaceFailure("workspace_read_only", "locked"));
  await frames();
  await clock.advance(1000);
  act(() => clearWorkspaceFailure());
  await frames();
  await clock.advance(EXIT_MS * 3);
  const slot = container.querySelector(".workspace-band-slot");
  expect(slot?.getAttribute("data-open")).toBe("true");
  expect(slot?.querySelector(".workspace-band-reserve")).not.toBeNull();
  expect(slot?.querySelector('[data-slot="workspace-band"]')).toBeNull();
});
