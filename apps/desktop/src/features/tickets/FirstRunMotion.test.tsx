// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MotionProvider, Presence } from "@/components/ui/motion";
import { Step, Steps } from "@/components/ui/steps";
import { agentSkillsClient } from "@/lib/api/agent-skills";
import { frames, freezeMotionClock } from "@/test/motion-clock";
import {
  applyTokens,
  instantTokens,
  reducedTokens,
  rootTokens,
} from "@/test/motion-tokens";
import { FirstRunGuide } from "./FirstRunGuide";

// First run (DESIGN.md section 12): the guide arrives in a cascade of its own,
// fades out when the first ticket exists, and a step that completes draws its
// check. Motion time is the test's own (test/motion-clock), so nothing depends
// on how fast the machine runs.

vi.mock("@/lib/api/agent-skills", () => ({
  agentSkillsClient: { list: vi.fn() },
}));

const EXIT_MS = 150;

let restoreTokens: () => void;
let clock: ReturnType<typeof freezeMotionClock>;
beforeEach(() => {
  vi.mocked(agentSkillsClient.list).mockResolvedValue([]);
  restoreTokens = applyTokens(rootTokens);
  clock = freezeMotionClock();
});
afterEach(() => {
  cleanup();
  clock.restore();
  restoreTokens();
});

function Guide({ first }: { first: boolean }) {
  return (
    <MotionProvider>
      <Presence>
        {first && (
          <FirstRunGuide
            key="guide"
            disabledReason={null}
            onCreate={() => {}}
          />
        )}
      </Presence>
    </MotionProvider>
  );
}

const host = () => document.querySelector<HTMLElement>(".first-run-host");

test("the guide arranges its own entrance: icon, title, lede, each step, hint, one stagger step apart", () => {
  render(<Guide first />);
  expect(host()?.hasAttribute("data-own-entrance")).toBe(true);
  const parts = Array.from(
    host()!.querySelectorAll<HTMLElement>("[data-enter]"),
  );
  expect(
    parts.map((part) => part.style.getPropertyValue("--enter-step")),
  ).toEqual(["0", "1", "2", "3", "4", "5", "6"]);
  expect(parts[1]?.querySelector("h2")).not.toBeNull();
  // The three steps are three parts, not one block.
  expect(parts.slice(3, 6).map((part) => part.dataset.slot)).toEqual([
    "step",
    "step",
    "step",
  ]);
  expect(parts[6]?.textContent).toContain("to search or jump anywhere");
});

test("once the first ticket exists the guide lets go of its space and fades out in the exit time", async () => {
  const { rerender } = render(<Guide first />);
  await frames();
  rerender(<Guide first={false} />);
  expect(host()?.dataset.leaving).toBe("true");
  await frames();
  await clock.advance(EXIT_MS - 10);
  expect(host()).not.toBeNull();
  await clock.advance(20);
  expect(host()).toBeNull();
});

test.each([
  ["reduced motion", reducedTokens],
  ["a held key or rapid clicks", instantTokens],
])("with %s the guide goes at once", async (_name, tokens) => {
  restoreTokens();
  restoreTokens = applyTokens({ ...rootTokens, ...tokens });
  const { rerender } = render(<Guide first />);
  rerender(<Guide first={false} />);
  await frames();
  expect(host()).toBeNull();
});

const drawn = () => document.querySelector('[data-slot="drawn-path"]');

test("a step that completes while on screen draws its check", () => {
  const view = (state?: "done") => (
    <Steps>
      <Step title="Install" {...(state && { state })} />
    </Steps>
  );
  const { rerender } = render(view());
  expect(drawn()).toBeNull();
  rerender(view("done"));
  expect(drawn()).not.toBeNull();
  expect(screen.getByText(/Completed/)).toBeTruthy();
});

test("a step that arrives done just shows its check", () => {
  render(
    <Steps>
      <Step title="Install" state="done" />
    </Steps>,
  );
  expect(drawn()).toBeNull();
  expect(
    document.querySelector('[data-slot="step-number"] svg'),
  ).not.toBeNull();
});

test("a step whose state is still being read shows its check, not a drawing, when it turns out done", () => {
  const view = (state: "done" | undefined, settled: boolean) => (
    <Steps>
      <Step title="Install" settled={settled} {...(state && { state })} />
    </Steps>
  );
  const { rerender } = render(view(undefined, false));
  rerender(view("done", true));
  expect(drawn()).toBeNull();
  expect(
    document.querySelector('[data-slot="step-number"] svg'),
  ).not.toBeNull();
});

test("a step read as not done draws its check when it completes later", () => {
  const view = (state: "done" | undefined, settled: boolean) => (
    <Steps>
      <Step title="Install" settled={settled} {...(state && { state })} />
    </Steps>
  );
  const { rerender } = render(view(undefined, false));
  rerender(view(undefined, true));
  rerender(view("done", true));
  expect(drawn()).not.toBeNull();
});

test("the guide shows the skill step done, not drawn, when the skill was installed all along", async () => {
  vi.mocked(agentSkillsClient.list).mockResolvedValue([
    {
      id: "claude",
      name: "Claude Code",
      path: "/skills",
      detected: true,
      state: "installed",
      error: null,
    },
  ]);
  render(<Guide first />);
  expect(await screen.findByText(/Completed:/)).toBeTruthy();
  expect(drawn()).toBeNull();
  expect(
    document.querySelector('[data-state="done"] [data-slot="step-number"] svg'),
  ).not.toBeNull();
});
