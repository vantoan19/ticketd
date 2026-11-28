// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { bridgeDefault, unknownCommands } from "@/test/bridge-defaults";
import { TestOpenTicket } from "./open-ticket/testing";
import { StatusLineRegion } from "@/components/ui/status-line";
import type { Ticket } from "@/lib/api/client";
import { TicketPage } from "./TicketPage";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);

const review: Ticket = {
  id: "review",
  reference: "T-KQ1",
  title: "Ship the rail",
  body: "## Draft\n\n- [x] An unrelated task\n\n## How would you know it worked?\n\n- [x] One\n- [ ] Two\n\n## Links\n\n- [x] Another unrelated task",
  status: "In review",
  trashed: false,
  tags: [],
  project_id: null,
  plan_id: null,
  availability: null,
  parent: null,
  children: [],
  prerequisites: [],
};

let ticket: Ticket;
let latest: ReturnType<typeof update> | null;
function update(text: string) {
  return {
    activity_id: "report",
    brief: { text, truncated: false },
    reported_at: "2026-11-28T03:00:00Z",
    updated_at: "2026-11-28T03:00:00Z",
    editing_agent: "codex",
    supporting_document_id: null,
  };
}
beforeEach(() => {
  ticket = review;
  latest = update("Implemented the rail.");
  bridge.invoke.mockImplementation(async (command: string, args?: object) => {
    if (command === "show_ticket") return ticket;
    if (command === "latest_update") return latest;
    if (command === "change_ticket") {
      const patch = (args as { patch: { status: string; expected_status: string } }).patch;
      if (ticket.status !== patch.expected_status)
        throw { code: "conflict", message: "This ticket has changed." };
      ticket = { ...ticket, status: patch.status };
      return ticket;
    }
    if (command === "add_activity_with_details") {
      const { brief } = args as { brief: string };
      latest = update(brief);
      return {
        id: latest.activity_id,
        ticket_id: ticket.id,
        brief,
        reported_at: latest.reported_at,
        updated_at: latest.updated_at,
        editing_agent: null,
        supporting_document_id: null,
      };
    }
    if (command === "is_following") return false;
    if (command === "reminder") return null;
    return bridgeDefault(command, args as { reference?: string });
  });
});
afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
  expect(unknownCommands.splice(0)).toEqual([]);
});

function open(select = vi.fn()) {
  return render(
    <StatusLineRegion>
      <TestOpenTicket ticket={ticket}>
        <TicketPage
          active
          projects={[]}
          plans={[]}
          select={select}
          onOpenGraph={vi.fn()}
          noteTarget={null}
          mention={null}
          onMention={vi.fn()}
        />
      </TestOpenTicket>
    </StatusLineRegion>,
  );
}

test("a reviewer reads the latest report and jumps to the acceptance checklist", async () => {
  open();
  const card = within(
    await screen.findByRole("region", { name: "Ready for review" }),
  );
  expect(await card.findByText("Implemented the rail.")).toBeTruthy();
  expect(card.getByText("codex")).toBeTruthy();
  fireEvent.click(card.getByRole("button", { name: "Acceptance 1 of 2" }));
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "How would you know it worked?" }),
    ),
  );
});


test("a review decision uses the current status, stays on the ticket and offers Undo", async () => {
  const select = vi.fn();
  open(select);
  fireEvent.click(await screen.findByRole("button", { name: "Move to Done" }));
  const card = await screen.findByRole("region", { name: "Done" });
  expect(within(card).getByText("Done · just now · by you")).toBeTruthy();
  expect(document.activeElement).toBe(within(card).getByText("Nothing else in review"));
  expect(screen.getByText("Moved T-KQ1 to Done")).toBeTruthy();
  expect(select).not.toHaveBeenCalled();
  expect(bridge.invoke).toHaveBeenCalledWith("change_ticket", {
    reference: "T-KQ1",
    patch: { expected_status: "In review", status: "Done" },
    requestId: expect.any(String),
  });
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(await screen.findByRole("region", { name: "Ready for review" })).toBeTruthy();
  expect(bridge.invoke).toHaveBeenCalledWith("change_ticket", {
    reference: "T-KQ1",
    patch: { expected_status: "Done", status: "In review" },
    requestId: expect.any(String),
  });
});


test("Reply posts an update in the card and keeps the ticket In progress", async () => {
  ticket = { ...review, status: "In progress" };
  open();
  const card = within(await screen.findByRole("region", { name: "Latest update" }));
  expect(card.queryByText("Acceptance 1 of 2")).toBeNull();
  fireEvent.click(card.getByRole("button", { name: "Reply" }));
  const field = card.getByRole("textbox", { name: "Reply" });
  expect(document.activeElement).toBe(field);
  fireEvent.change(field, { target: { value: "Please include the screenshots." } });
  fireEvent.click(card.getByRole("button", { name: "Post update" }));
  expect(await card.findByText("Please include the screenshots.")).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "Status: In progress" })).toBeTruthy();
  expect(bridge.invoke).toHaveBeenCalledWith("add_activity_with_details", {
    reference: "T-KQ1",
    brief: "Please include the screenshots.",
    details: null,
    existingDocumentId: null,
    requestId: expect.any(String),
  });
});
