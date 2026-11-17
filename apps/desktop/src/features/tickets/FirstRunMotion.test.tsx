// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MotionProvider, Presence } from "@/components/ui/motion";
import { Step, Steps } from "@/components/ui/steps";
import { agentSkillsClient } from "@/lib/api/agent-skills";
import {
  applyTokens,
  instantTokens,
  reducedTokens,
  rootTokens,
} from "@/test/motion-tokens";
import { FirstRunGuide } from "./FirstRunGuide";

// First run (DESIGN.md section 12): the guide arrives in a cascade, fades out
// when the first ticket exists, and a step that completes draws its check.

vi.mock("@/lib/api/agent-skills", () => ({
  agentSkillsClient: { list: vi.fn() },
}));

let restoreTokens: () => void;
beforeEach(() => {
  vi.mocked(agentSkillsClient.list).mockResolvedValue([]);
  restoreTokens = applyTokens(rootTokens);
});
afterEach(() => {
  cleanup();
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

test("the guide arrives as a cascade of soft blocks: icon, title, lede, steps, hint", () => {
  render(<Guide first />);
  const blocks = Array.from(
    document.querySelectorAll<HTMLElement>('[data-slot="appear"]'),
  );
  expect(blocks).toHaveLength(5);
  expect(blocks.every((block) => block.style.opacity === "0")).toBe(true);
  expect(blocks[1]?.querySelector("h2")).not.toBeNull();
  expect(blocks[3]?.querySelector('[data-slot="steps"]')).not.toBeNull();
});

test("once the first ticket exists the guide lets go of its space and fades out in the exit time", async () => {
  const { rerender } = render(<Guide first />);
  rerender(<Guide first={false} />);
  expect(host()?.dataset.leaving).toBe("true");
  const start = performance.now();
  await waitFor(() => expect(host()).toBeNull(), { interval: 4 });
  expect(performance.now() - start).toBeGreaterThanOrEqual(140);
});

test.each([
  ["reduced motion", reducedTokens],
  ["a held key or rapid clicks", instantTokens],
])("with %s the guide goes at once", async (_name, tokens) => {
  restoreTokens();
  restoreTokens = applyTokens({ ...rootTokens, ...tokens });
  const { rerender } = render(<Guide first />);
  rerender(<Guide first={false} />);
  const start = performance.now();
  await waitFor(() => expect(host()).toBeNull(), { interval: 4 });
  expect(performance.now() - start).toBeLessThan(100);
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
