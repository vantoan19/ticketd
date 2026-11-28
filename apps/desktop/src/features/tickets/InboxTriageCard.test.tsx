// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { Ticket } from "@/lib/api/client";
import { TestReads } from "@/lib/workspace-reads/testing";
import { InboxTriageCard } from "./InboxTriageCard";
import {
  InboxTriageContext,
  type TriageSelection,
} from "./inbox-triage-context";
import { AgentContext } from "./ticket-agent-context";
import type { Entry } from "./inboxModel";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const ticket = (trashed: boolean): Ticket => ({
  id: "1",
  reference: "T-KQ1",
  title: "Protocol",
  status: "Todo",
  trashed,
  body: "",
  project_id: null,
  plan_id: null,
  availability: null,
  tags: [],
  parent: null,
  children: [],
  prerequisites: [],
});

const entry = (over: Partial<Entry>): Entry => ({
  id: 1,
  reference: "T-KQ1",
  title: "Protocol",
  kind: "reminder",
  from_value: "",
  to_value: "2020-01-01T00:00:00Z",
  timestamp: new Date().toISOString(),
  read: false,
  editing_agent: null,
  ...over,
});

function card(selected: Entry, record: Ticket): ReactNode {
  const selection: TriageSelection = { kind: "entry", entry: selected };
  return (
    <TestReads primed={{ ticket: record }}>
      <AgentContext
        value={{
          reference: record.reference,
          openedWithCard: false,
          ready: true,
          state: null,
          reportUnknownAnswer: () => {},
          update: null,
        }}
      >
        <InboxTriageContext
          value={{
            selection,
            line: { show: () => {}, dismiss: () => {} },
            chatId: null,
            openChat: () => {},
            position: null,
            setPosition: () => {},
            adjacent: () => {},
            registerWalk: () => {},
            choose: () => {},
          }}
        >
          <InboxTriageCard />
        </InboxTriageContext>
      </AgentContext>
    </TestReads>
  );
}

afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
});

test("a due reminder on a Ticket in Trash can be cleared, but not replied to", async () => {
  bridge.invoke.mockImplementation(async (command: string) =>
    command === "reminder" ? "2020-01-01T00:00:00Z" : undefined,
  );
  render(card(entry({}), ticket(true)));
  const clear = await screen.findByRole("button", { name: /Clear reminder/ });
  expect((clear as HTMLButtonElement).disabled).toBe(false);
  expect(
    (screen.getByRole("button", { name: /Snooze/ }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  expect(
    (screen.getByRole("button", { name: /Reply/ }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  // The copy names what is blocked; Clear and Snooze still work.
  expect(
    screen.getByText("Restore the Ticket to reply or change it."),
  ).toBeTruthy();
  fireEvent.click(clear);
  await vi.waitFor(() =>
    expect(bridge.invoke).toHaveBeenCalledWith(
      "set_reminder",
      expect.objectContaining({ reference: "T-KQ1", dueAt: null }),
    ),
  );
});

test("the triage card reads an Activity's Markdown brief as plain text", async () => {
  render(
    card(
      entry({
        kind: "activity",
        to_value: "Needs review of the **conflict** section.",
        editing_agent: "claude-code",
      }),
      ticket(false),
    ),
  );
  expect(
    await screen.findByText("Needs review of the conflict section."),
  ).toBeTruthy();
});
