// @vitest-environment jsdom
import { StrictMode, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Ticket } from "@/lib/api/client";
import { TestReads } from "@/lib/workspace-reads/testing";
import { fakeChangeSignal } from "@/lib/workspace-reads/fake-signal";
import type { ChangeSignal } from "@/lib/workspace-reads";
import { bridgeDefault, unknownCommands } from "@/test/bridge-defaults";
import { TicketDetails } from "./TicketDetails";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);

const ticket: Ticket = {
  id: "ship-rail",
  reference: "T-KQ1",
  title: "Ship the rail",
  body: "The updated reading layout.",
  status: "In progress",
  project_id: null,
  plan_id: null,
  availability: null,
  tags: [],
  trashed: false,
  parent: null,
  children: [],
  prerequisites: [],
};
const other = {
  ...ticket,
  id: "other-ticket",
  reference: "T-KQ2",
  title: "Another ticket",
  status: "Todo",
};
const at = (day: number) => `2026-11-${day}T11:00:00.000Z`;

function update(id: string, brief: string, day: number, author: string | null) {
  return {
    type: "authored" as const,
    activity: {
      id,
      brief,
      ticket_id: ticket.id,
      reported_at: at(day),
      updated_at: at(day),
      editing_agent: author,
      supporting_document_id: null,
    },
  };
}

let record: Ticket;
let updates: ReturnType<typeof update>[];
let workspace: string;

beforeEach(() => {
  localStorage.clear();
  workspace = "my-workspace";
  record = ticket;
  updates = [update("old", "Previous report", 21, "codex")];
  bridge.invoke.mockImplementation(
    async (command: string, args?: { reference?: string }) => {
      const selected = args?.reference === ticket.reference;
      if (command === "show_ticket") return selected ? record : other;
      if (command === "attachment_workspace_id") return workspace;
      if (command === "activity_feed") return selected ? updates : [];
      if (command === "latest_update") {
        const latest = selected ? updates[0]?.activity : undefined;
        return latest
          ? {
              ...latest,
              activity_id: latest.id,
              brief: { text: latest.brief, truncated: false },
            }
          : null;
      }
      return bridgeDefault(command, args);
    },
  );
});

afterEach(async () => {
  cleanup();
  await Promise.resolve();
  vi.restoreAllMocks();
  bridge.invoke.mockReset();
  expect(unknownCommands.splice(0)).toEqual([]);
  localStorage.clear();
});

function Detail({ signal }: { signal?: ChangeSignal } = {}) {
  const [selected, setSelected] = useState<string | null>(ticket.reference);
  return (
    <TestReads {...(signal && { signal })}>
      <button type="button" onClick={() => setSelected(ticket.reference)}>
        Open first ticket
      </button>
      <TicketDetails
        selected={selected}
        opened={[ticket.reference, other.reference]}
        onAdjacent={() =>
          setSelected(
            selected === ticket.reference ? other.reference : ticket.reference,
          )
        }
        position={{ index: selected === ticket.reference ? 1 : 2, total: 2 }}
        mention={null}
        expanded={false}
        onExpand={() => {}}
        onReturn={() => {}}
        setSelected={setSelected}
        projects={[]}
        plans={[]}
        onMentionReady={() => {}}
        onClearMention={() => {}}
      />
    </TestReads>
  );
}

function addNewUpdates() {
  updates = [
    update("latest", "Most recent report", 25, "codex"),
    update("mine", "My update", 24, null),
    update("another-report", "Another new report", 23, "claude"),
    ...updates,
  ];
}

const card = () =>
  within(screen.getByRole("region", { name: "Latest update" }));
const activity = () => within(screen.getByRole("region", { name: "Activity" }));
const stub = /^↑ Latest update,/;

test("uses a stub only while the card shows the update", async () => {
  render(<Detail />);
  await screen.findByRole("region", { name: "Latest update" });
  expect(await card().findByText("Previous report")).toBeTruthy();
  expect(await activity().findByText(stub)).toBeTruthy();
  expect(activity().queryByText("Previous report")).toBeNull();
  expect(screen.queryByRole("img", { name: "New" })).toBeNull();

  cleanup();
  record = { ...ticket, status: "Todo" };
  render(<Detail />);
  await screen.findByRole("region", { name: "Activity" });
  expect(await activity().findByText("Previous report")).toBeTruthy();
  expect(activity().queryByText(stub)).toBeNull();
});

test.each(["close", "switch", "quit"] as const)(
  "catches up since last leaving by %s",
  async (way) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(at(22)));
    const signal = fakeChangeSignal();
    const first = render(
      <StrictMode>
        <Detail signal={signal} />
      </StrictMode>,
    );
    await screen.findByRole("region", { name: "Latest update" });
    await card().findByText("Previous report");
    expect(screen.queryByRole("img", { name: "New" })).toBeNull();

    if (way === "close") {
      fireEvent.click(
        screen.getByRole("button", { name: "Close ticket details" }),
      );
    } else if (way === "switch") {
      fireEvent.click(screen.getByRole("button", { name: "Next ticket" }));
      await screen.findByRole("heading", { name: "Another ticket" });
    } else {
      window.dispatchEvent(new Event("ticketd:window-quitting"));
    }
    await act(async () => {});
    vi.mocked(Date.now).mockReturnValue(Date.parse(at(26)));
    addNewUpdates();
    await act(async () => signal.change());
    if (way === "close") {
      fireEvent.click(
        screen.getByRole("button", { name: "Open first ticket" }),
      );
    } else if (way === "switch") {
      fireEvent.click(screen.getByRole("button", { name: "Previous ticket" }));
    } else {
      first.unmount();
      render(<Detail />);
    }
    await screen.findByRole("region", { name: "Latest update" });
    await card().findByText("Most recent report");
    expect(await card().findByRole("img", { name: "New" })).toBeTruthy();
    expect(
      await activity().findByText("New since you last looked"),
    ).toBeTruthy();
    const anotherReport = activity().getByRole("article", {
      name: "Update by claude",
    });
    expect(
      within(anotherReport).getByRole("img", { name: "New" }),
    ).toBeTruthy();
    const mine = activity().getByRole("article", { name: "Update by you" });
    expect(within(mine).queryByRole("img", { name: "New" })).toBeNull();
    const earlierReport = activity().getByRole("article", {
      name: "Update by codex",
    });
    expect(
      within(earlierReport).queryByRole("img", { name: "New" }),
    ).toBeNull();
  },
);

test("an earlier visit applies only inside the same Workspace", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(at(22)));
  render(<Detail />);
  await screen.findByRole("region", { name: "Latest update" });
  await card().findByText("Previous report");
  fireEvent.click(screen.getByRole("button", { name: "Close ticket details" }));
  await act(async () => {});
  cleanup();

  workspace = "another-workspace";
  vi.mocked(Date.now).mockReturnValue(Date.parse(at(26)));
  addNewUpdates();
  render(<Detail />);
  await screen.findByRole("region", { name: "Latest update" });
  await card().findByText("Most recent report");
  expect(screen.queryByRole("img", { name: "New" })).toBeNull();
  cleanup();

  workspace = "my-workspace";
  render(<Detail />);
  await screen.findByRole("region", { name: "Latest update" });
  expect(await card().findByRole("img", { name: "New" })).toBeTruthy();
});
