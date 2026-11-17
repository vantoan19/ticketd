// @vitest-environment jsdom
import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useWrote } from "@/lib/workspace-reads";
import { fakeChangeSignal } from "@/lib/workspace-reads/fake-signal";
import { deferred, settle } from "@/lib/workspace-reads/test-support";
import { TestReads } from "@/lib/workspace-reads/testing";
import { useTicket } from "./open-ticket";
import { ticketFor } from "./open-ticket/parts/ticket-fixture";
import { useMentionReadiness } from "./use-mention-readiness";
import type { FollowedMention } from "./useTicketWorkspace";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
});

const mention = {
  reference: "T-2",
  mentioned: "T-1",
  noteId: null,
  passage: "mention",
  start: 0,
  end: 7,
  key: 1,
  ready: false,
} as unknown as FollowedMention;

/** The body the page holds once the mention is judged, and "waiting" before. */
function Harness() {
  const [active, setActive] = useState<FollowedMention | null>(null);
  const [ready, setReady] = useState(false);
  const record = useTicket("T-2");
  const wrote = useWrote();
  useMentionReadiness({
    selected: "T-2",
    mention: active,
    onReady: () => setReady(true),
    onEnd: () => {},
  });
  return (
    <>
      <button type="button" onClick={() => setActive(mention)}>
        Follow
      </button>
      <button type="button" onClick={() => void wrote()}>
        Write
      </button>
      <output aria-label="judged">
        {ready ? (record.value?.body ?? "(none)") : "waiting"}
      </output>
    </>
  );
}
const judged = () => screen.getByLabelText("judged").textContent;

describe("a followed mention is judged against a read made after it was followed", () => {
  test("a failure kept from before still forces that read", async () => {
    let fail = false;
    let reply = deferred<ReturnType<typeof ticketFor>>();
    let hold = false;
    bridge.invoke.mockImplementation(async () => {
      if (hold) return reply.promise;
      if (fail) throw { code: "workspace_locked", message: "locked" };
      return ticketFor("T-2", { body: "old body" });
    });
    const signal = fakeChangeSignal();
    render(
      <TestReads signal={signal}>
        <Harness />
      </TestReads>,
    );
    await settle();
    // A change's re-read fails: the last good copy and the failure are kept.
    fail = true;
    await act(async () => signal.change());
    await settle();

    fail = false;
    hold = true;
    reply = deferred();
    fireEvent.click(screen.getByRole("button", { name: "Follow" }));
    await settle();
    expect(judged()).toBe("waiting");
    await act(async () =>
      reply.resolve(ticketFor("T-2", { body: "new body with the mention" })),
    );
    expect(judged()).toBe("new body with the mention");
  });

  test("an own write during the forced read does not let it be judged before the new body", async () => {
    const reads: ReturnType<typeof deferred<ReturnType<typeof ticketFor>>>[] =
      [];
    let hold = false;
    bridge.invoke.mockImplementation(async () => {
      if (!hold) return ticketFor("T-2", { body: "old body" });
      const next = deferred<ReturnType<typeof ticketFor>>();
      reads.push(next);
      return next.promise;
    });
    render(
      <TestReads>
        <Harness />
      </TestReads>,
    );
    await settle();
    hold = true;
    fireEvent.click(screen.getByRole("button", { name: "Follow" }));
    await settle();
    expect(reads).toHaveLength(1);

    // A write of this window takes the forced read's place.
    fireEvent.click(screen.getByRole("button", { name: "Write" }));
    await settle();
    expect(reads.length).toBeGreaterThanOrEqual(2);
    await act(async () =>
      reads[0]?.resolve(ticketFor("T-2", { body: "old body" })),
    );
    expect(judged()).toBe("waiting");
    await act(async () =>
      reads[reads.length - 1]?.resolve(ticketFor("T-2", { body: "new body" })),
    );
    expect(judged()).toBe("new body");
  });

  test("it is judged against what is cached when that read fails", async () => {
    let fail = false;
    bridge.invoke.mockImplementation(async () => {
      if (fail) throw { code: "workspace_locked", message: "locked" };
      return ticketFor("T-2", { body: "old body" });
    });
    render(
      <TestReads>
        <Harness />
      </TestReads>,
    );
    await settle();
    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Follow" }));
    await settle();
    expect(judged()).toBe("old body");
  });
});
