// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { TestReads } from "@/lib/workspace-reads/testing";
import { LatestUpdate } from "./LatestUpdate";
import { TicketAgentSession } from "./TicketAgent";
import { OpenTicketFor, ticketFor } from "./open-ticket/parts/activity-testing";

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
