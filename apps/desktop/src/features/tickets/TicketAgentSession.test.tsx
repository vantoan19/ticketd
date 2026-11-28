// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { useContext, type ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { TestReads } from "@/lib/workspace-reads/testing";
import { LatestUpdate } from "./LatestUpdate";
import { TicketAgentSession } from "./TicketAgent";
import { useTicket } from "./open-ticket";
import { OpenTicketFor } from "./open-ticket/parts/activity-testing";
import { ticketFor } from "./open-ticket/parts/ticket-fixture";
import { AgentContext } from "./ticket-agent-context";

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
const ticket = ticketFor("T-KQ1");

function Session({ children }: { children?: ReactNode }) {
  const record = useTicket(ticket.reference);
  return (
    <TicketAgentSession
      selected={ticket.reference}
      record={record}
      preview={ticket}
    >
      {(loading) => (
        <>
          <output>{loading ? "loading" : "ready"}</output>
          {children}
        </>
      )}
    </TicketAgentSession>
  );
}

function AgentReadiness() {
  return (
    <output>
      {useContext(AgentContext)?.ready
        ? "Agent context ready"
        : "Agent context unavailable"}
    </output>
  );
}

test("the agent context waits for the latest update, then is ready", async () => {
  bridge.invoke.mockResolvedValue(report);
  render(
    <TestReads primed={{ ticket }}>
      <Session />
    </TestReads>,
  );
  expect(screen.getByText("loading")).toBeTruthy();
  expect(await screen.findByText("ready")).toBeTruthy();
});

test("the agent context and the Latest update property share one read", async () => {
  bridge.invoke.mockResolvedValue(report);
  render(
    <OpenTicketFor reference={ticket.reference}>
      <Session>
        <LatestUpdate active />
      </Session>
    </OpenTicketFor>,
  );
  await screen.findByText("ready");
  await screen.findByText("Drafted a fix");
  expect(
    bridge.invoke.mock.calls.filter(([command]) => command === "latest_update"),
  ).toHaveLength(1);
});

test("the agent context is ready even when the Ticket's record cannot be read", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "show_ticket")
      throw { code: "failed", message: "disk hiccup" };
    return null;
  });
  render(
    <TestReads>
      <Session>
        <AgentReadiness />
      </Session>
    </TestReads>,
  );
  expect(await screen.findByText("Agent context ready")).toBeTruthy();
  expect(bridge.invoke).toHaveBeenCalledWith("show_ticket", {
    reference: ticket.reference,
  });
});

test("a failed read of the latest update still lets the page open", async () => {
  bridge.invoke.mockRejectedValue(new Error("Database unavailable"));
  render(
    <TestReads primed={{ ticket }}>
      <Session />
    </TestReads>,
  );
  expect(await screen.findByText("ready")).toBeTruthy();
});
