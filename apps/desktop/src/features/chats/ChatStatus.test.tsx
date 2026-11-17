// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { MotionProvider } from "@/components/ui/motion";
import { ChatStatus } from "@/features/chats/ChatStatus";
import type { ChatStatus as Status } from "@/features/chats/client";
import { frames, freezeMotionClock } from "@/test/motion-clock";
import { applyTokens, rootTokens } from "@/test/motion-tokens";

// A Chat that starts needing you (DESIGN.md, Chat): its status dot arrives
// first, then the word crossfades.

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

const working: Status = { rank: "working", unseen: false, word: "Working" };
const asking: Status = {
  rank: "approval",
  unseen: false,
  word: "Approval needed",
};

function Line({ status }: { status: Status }) {
  return (
    <MotionProvider>
      <ChatStatus status={status} activity="idle" />
    </MotionProvider>
  );
}

const line = () => document.querySelector<HTMLElement>(".chat-status")!;
const word = (text: string) => screen.getByText(text);

test("a dot that was there when the line was drawn does not arrive", () => {
  render(<Line status={asking} />);
  expect(line().hasAttribute("data-arrived")).toBe(false);
  expect(line().querySelector('[data-slot="status-dot"]')).not.toBeNull();
});

test("a dot that appears while the line is on screen arrives", () => {
  const { rerender } = render(<Line status={working} />);
  expect(line().querySelector('[data-slot="status-dot"]')).toBeNull();
  rerender(<Line status={asking} />);
  expect(line().hasAttribute("data-arrived")).toBe(true);
  expect(line().querySelector('[data-slot="status-dot"]')).not.toBeNull();
});

test("the new word waits for the dot, then fades in", async () => {
  const { rerender } = render(<Line status={working} />);
  rerender(<Line status={asking} />);
  await frames();
  await clock.advance(40);
  expect(word("Approval needed").style.opacity).toBe("0");
  await clock.advance(2000);
  expect(word("Approval needed").style.opacity).toBe("1");
});

test("a word that changes with no dot arriving crossfades at once", async () => {
  const { rerender } = render(<Line status={asking} />);
  rerender(
    <Line status={{ rank: "approval", unseen: false, word: "Choose one" }} />,
  );
  await frames();
  await clock.advance(40);
  expect(Number(word("Choose one").style.opacity)).toBeGreaterThan(0);
});
