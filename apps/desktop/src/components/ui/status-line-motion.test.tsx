// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { MotionProvider } from "./motion";
import { StatusLineRegion } from "./status-line";
import { useStatusLine, type StatusLineMessage } from "./use-status-line";
import { applyTokens, reducedTokens, rootTokens } from "@/test/motion-tokens";

// How the status line moves (DESIGN.md section 12): it rises from a soft blur,
// leaves in 150ms, and a following outcome crossfades its words in the same
// line. Time is real, because the motion library takes frames from the real
// requestAnimationFrame; a motion never finishes sooner than its duration.

const EXIT_MS = 150;

let restoreTokens: () => void;
beforeEach(() => {
  restoreTokens = applyTokens(rootTokens);
});
afterEach(() => {
  cleanup();
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

async function leaves(text: string): Promise<number> {
  const start = performance.now();
  await waitFor(() => expect(screen.queryByText(text)).toBeNull(), {
    interval: 4,
  });
  return performance.now() - start;
}

it("rises 8px from a soft blur, and settles", async () => {
  region();
  post({ message: "Copied" });
  const line = chrome()[0]!;
  expect(line.style.opacity).toBe("0");
  expect(line.style.transform).toContain("translateY(8px)");
  expect(line.style.filter).toBe("blur(4px)");
  await waitFor(() => expect(line.style.opacity).toBe("1"));
});

it("fades out in its own time after Dismiss, and cannot be pressed meanwhile", async () => {
  region();
  post({ message: "Moved T-1 to Trash", undo: () => {} });
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(screen.queryByText("Moved T-1 to Trash")).not.toBeNull();
  expect(
    document.querySelector(".ui-status-line-slot")?.hasAttribute("inert"),
  ).toBe(true);
  expect(await leaves("Moved T-1 to Trash")).toBeGreaterThanOrEqual(
    EXIT_MS - 10,
  );
});

it("a following outcome crossfades its words in the same line", async () => {
  region();
  post({ message: "First" });
  post({ message: "Second" });
  expect(screen.queryByText("First")).not.toBeNull();
  expect(screen.queryByText("Second")).not.toBeNull();
  expect(chrome()).toHaveLength(1);
  expect(await leaves("First")).toBeGreaterThanOrEqual(EXIT_MS - 10);
  expect(chrome()).toHaveLength(1);
});

it("leaves at once under reduced motion", async () => {
  restoreTokens();
  restoreTokens = applyTokens({ ...rootTokens, ...reducedTokens });
  region();
  post({ message: "Copied" });
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(await leaves("Copied")).toBeLessThan(EXIT_MS - 10);
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
  expect(await leaves("Copied")).toBeLessThan(EXIT_MS - 10);
});
