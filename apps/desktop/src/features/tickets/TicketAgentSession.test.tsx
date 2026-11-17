// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fakeChangeSignal } from "@/lib/workspace-reads/fake-signal";
import { TestReads } from "@/lib/workspace-reads/testing";
import { LatestUpdate } from "./LatestUpdate";
import { TicketAgentSession, TicketAgentStrip } from "./TicketAgent";
import { OpenTicketFor } from "./open-ticket/parts/activity-testing";
import { ticketFor } from "./open-ticket/parts/ticket-fixture";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
});

const report = {
  activity_id: "a-1",
  brief: { text: "Drafted a fix", truncated: false },
  reported_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  editing_agent: "Agent",
  supporting_document_id: null,
};

test("the agent line waits for the latest update, then is ready", async () => {
  bridge.invoke.mockResolvedValue(report);
  render(
    <TestReads primed={{ ticket: ticketFor("T-KQ1") }}>
      <TicketAgentSession ticket={ticketFor("T-KQ1")}>
        {(loading) => <output>{loading ? "loading" : "ready"}</output>}
      </TicketAgentSession>
    </TestReads>,
  );
  expect(screen.getByText("loading")).toBeTruthy();
  expect(await screen.findByText("ready")).toBeTruthy();
});

test("the agent line and the Latest update property share one read", async () => {
  bridge.invoke.mockResolvedValue(report);
  render(
    <OpenTicketFor reference="T-KQ1">
      <TicketAgentSession ticket={ticketFor("T-KQ1")}>
        {(loading) => (
          <>
            <output>{loading ? "loading" : "ready"}</output>
            <LatestUpdate active />
          </>
        )}
      </TicketAgentSession>
    </OpenTicketFor>,
  );
  await screen.findByText("ready");
  await screen.findByText("Drafted a fix");
  expect(
    bridge.invoke.mock.calls.filter(([command]) => command === "latest_update"),
  ).toHaveLength(1);
});

describe("the slot is decided from a read made since the opening", () => {
  let updates: Record<string, unknown>;
  beforeEach(() => {
    updates = { "T-5": null, "T-6": null };
    bridge.invoke.mockImplementation(async (command: string, args: unknown) => {
      const { reference } = args as { reference: string };
      if (command === "latest_update") return updates[reference] ?? null;
      throw new Error(`unexpected ${command}`);
    });
  });

  function Selected({ reference }: { reference: string }) {
    return (
      <TicketAgentSession ticket={ticketFor(reference)}>
        {(loading) => (
          <>
            <output aria-label="agent state">
              {loading ? "loading" : "ready"}
            </output>
            <TicketAgentStrip reference={reference} />
          </>
        )}
      </TicketAgentSession>
    );
  }

  test("an update posted while the Ticket was not selected is seen on reopening", async () => {
    const signal = fakeChangeSignal();
    const view = (reference: string) => (
      <TestReads signal={signal}>
        <Selected reference={reference} />
      </TestReads>
    );
    const { rerender } = render(view("T-5"));
    await screen.findByText("ready");
    expect(screen.queryByRole("status", { name: "Ticket agent" })).toBeNull();

    rerender(view("T-6"));
    await screen.findByText("ready");
    // The agent posts its first update on T-5 while another Ticket is open.
    updates["T-5"] = report;
    act(() => signal.change());

    rerender(view("T-5"));
    expect(screen.getByLabelText("agent state").textContent).toBe("loading");
    expect(
      await screen.findByRole("status", { name: "Ticket agent" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Go to update: Drafted a fix" }),
    ).toBeTruthy();
  });
});

test("the agent line is ready even when the Ticket's record cannot be read", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "show_ticket")
      throw { code: "failed", message: "disk hiccup" };
    return null;
  });
  render(
    <TestReads>
      <TicketAgentSession ticket={ticketFor("T-KQ1")}>
        {(loading) => <output>{loading ? "loading" : "ready"}</output>}
      </TicketAgentSession>
    </TestReads>,
  );
  expect(await screen.findByText("ready")).toBeTruthy();
});

test("a failed read of the latest update still lets the page open", async () => {
  bridge.invoke.mockRejectedValue(new Error("Database unavailable"));
  render(
    <TestReads primed={{ ticket: ticketFor("T-KQ1") }}>
      <TicketAgentSession ticket={ticketFor("T-KQ1")}>
        {(loading) => <output>{loading ? "loading" : "ready"}</output>}
      </TicketAgentSession>
    </TestReads>,
  );
  expect(await screen.findByText("ready")).toBeTruthy();
});
