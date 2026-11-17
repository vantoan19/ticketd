// @vitest-environment jsdom
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MotionProvider } from "@/components/ui/motion";
import { applyTokens, rootTokens } from "@/test/motion-tokens";
import { fakeChangeSignal } from "@/lib/workspace-reads/fake-signal";
import { Activity } from "./Activity";
import { OpenTicketFor } from "./open-ticket/parts/activity-testing";

// Posting an update (DESIGN.md section 12): the new update opens its space at
// the top and fades up from a soft blur, the entries below glide down, and
// "Latest" fades off the previous update. What is there when Activity opens
// does not move.

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
Element.prototype.scrollIntoView ??= () => {};

let restoreTokens: () => void;
beforeEach(() => {
  restoreTokens = applyTokens(rootTokens);
});
afterEach(() => {
  cleanup();
  restoreTokens();
  bridge.invoke.mockReset();
});

const note = (id: string, brief: string, reportedAt: string) => ({
  type: "authored",
  activity: {
    id,
    ticket_id: "ticket-1",
    brief,
    reported_at: reportedAt,
    updated_at: reportedAt,
    editing_agent: null,
  },
});

const row = (text: string) =>
  screen.getByText(text).closest<HTMLElement>("li[data-slot=comment-row]")!;

async function open() {
  let feed = [note("a", "First update", "2026-01-01T00:00:00Z")];
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "activity_feed") return feed;
    if (command === "ticket_history") return [];
    throw new Error(`Unexpected ${command}`);
  });
  const signal = fakeChangeSignal();
  render(
    <MotionProvider>
      <OpenTicketFor reference="T-KQ1" signal={signal}>
        <Activity reference="T-KQ1" projects={[]} active trashed={false} />
      </OpenTicketFor>
    </MotionProvider>,
  );
  await screen.findByText("First update");
  return {
    post: async () => {
      feed = [note("b", "Second update", "2026-01-02T00:00:00Z"), ...feed];
      await act(async () => signal.change());
    },
  };
}

test("the update there when Activity opens shows without motion", async () => {
  await open();
  expect(row("First update").style.opacity).toBe("");
});

test("a new update fades up from a soft blur at the top and settles", async () => {
  const { post } = await open();
  // The read may land a frame after the row mounts, so watch what it shows.
  const opacities: number[] = [];
  const watch = new MutationObserver(() => {
    const added = screen.queryByText("Second update")?.closest("li");
    if (added) opacities.push(Number(added.style.opacity));
  });
  watch.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
  });
  await post();
  const added = await waitFor(() => row("Second update"));
  await waitFor(() => expect(added.style.opacity).toBe("1"));
  watch.disconnect();
  expect(opacities[0]).toBeLessThan(0.99);
  expect(added.compareDocumentPosition(row("First update"))).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  // The update below is not made to fade; it only glides down.
  expect(row("First update").style.opacity).toBe("");
});

test("Latest fades off the previous update", async () => {
  const { post } = await open();
  expect(row("First update").textContent).toContain("Latest");
  await post();
  const latest = await waitFor(() => {
    const second = row("Second update");
    expect(second.textContent).toContain("Latest");
    return second;
  });
  expect(latest).not.toBe(row("First update"));
  // It stays a moment on the previous update while it fades.
  expect(row("First update").textContent).toContain("Latest");
  await waitFor(() =>
    expect(row("First update").textContent).not.toContain("Latest"),
  );
});
