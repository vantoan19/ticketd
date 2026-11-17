// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { MotionProvider } from "./motion";
import { StatusLineRegion } from "./status-line";
import { useStatusLine, type StatusLineMessage } from "./use-status-line";
import { frames, freezeMotionClock } from "@/test/motion-clock";
import { applyTokens, reducedTokens, rootTokens } from "@/test/motion-tokens";

// How the status line moves (DESIGN.md section 12): it rises from a soft blur,
// leaves in 150ms, and a following outcome crossfades its words in the same
// line. Motion time is the test's own (test/motion-clock): it moves only when
// a test advances it, so nothing here depends on how fast the machine runs. A
// leave that is meant to be instant is gone after the next frame with time
// standing still; one that is not is still there until time covers its length.

const EXIT_MS = 150;

let restoreTokens: () => void;
let clock: ReturnType<typeof freezeMotionClock>;
beforeEach(() => {
  restoreTokens = applyTokens(rootTokens);
  clock = freezeMotionClock();
});
afterEach(() => {
  cleanup();
  clock.restore();
  restoreTokens();
});

const postRef: { current: (message: StatusLineMessage) => void } = {
  current: () => {},
};
function Poster() {
  const { show } = useStatusLine();
  useEffect(() => {
    postRef.current = show;
  });
  return null;
}
function region() {
  render(
    <MotionProvider>
      <StatusLineRegion>
        <Poster />
      </StatusLineRegion>
    </MotionProvider>,
  );
}
const post = (message: StatusLineMessage) =>
  act(() => postRef.current(message));
const chrome = () => document.querySelectorAll<HTMLElement>(".ui-status-line");
const rising = () =>
  document.querySelector<HTMLElement>(
    '.ui-status-line-slot [data-slot="appear"]',
  )!;

/** The line is on show after a frame, and stays until `EXIT_MS` of motion time. */
async function staysThenLeaves(text: string) {
  await frames();
  expect(screen.queryByText(text)).not.toBeNull();
  await clock.advance(EXIT_MS - 10);
  expect(screen.queryByText(text)).not.toBeNull();
  await clock.advance(20);
  expect(screen.queryByText(text)).toBeNull();
}

/** Gone after the next frame, with time standing still. */
async function leavesAtOnce(text: string) {
  await frames();
  expect(screen.queryByText(text)).toBeNull();
}

it("rises 8px from a soft blur, and settles", async () => {
  region();
  post({ message: "Copied" });
  const line = rising();
  expect(line.style.opacity).toBe("0");
  expect(line.style.transform).toContain("translateY(8px)");
  expect(line.style.filter).toBe("blur(4px)");
  await frames();
  await clock.advance(2000);
  expect(line.style.opacity).toBe("1");
});

it("fades out in its own time after Dismiss, and cannot be pressed meanwhile", async () => {
  region();
  post({ message: "Moved T-1 to Trash", undo: () => {} });
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(screen.queryByText("Moved T-1 to Trash")).not.toBeNull();
  expect(
    document.querySelector(".ui-status-line-slot")?.hasAttribute("inert"),
  ).toBe(true);
  await staysThenLeaves("Moved T-1 to Trash");
});

it("a following outcome crossfades its words in the same line", async () => {
  region();
  post({ message: "First" });
  post({ message: "Second" });
  expect(screen.queryByText("First")).not.toBeNull();
  expect(screen.queryByText("Second")).not.toBeNull();
  expect(chrome()).toHaveLength(1);
  await staysThenLeaves("First");
  expect(chrome()).toHaveLength(1);
});

it("leaves at once under reduced motion", async () => {
  restoreTokens();
  restoreTokens = applyTokens({ ...rootTokens, ...reducedTokens });
  region();
  post({ message: "Copied" });
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  await leavesAtOnce("Copied");
});

it("leaves at once while a key repeats", async () => {
  region();
  post({ message: "Copied" });
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "j", repeat: true }),
    );
  });
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  await leavesAtOnce("Copied");
});
