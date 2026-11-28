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
import { isMacPlatform } from "@/lib/platform";
import type { Evidence, Ticket } from "@/lib/api/client";
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
let evidence: { items: Evidence[]; total: number; proof: Evidence[] };
let writeFailure: string | null;
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
  evidence = { items: [], total: 0, proof: [] };
  writeFailure = null;
  bridge.invoke.mockImplementation(async (command: string, args?: object) => {
    if (command === "show_ticket") return ticket;
    if (command === "latest_update") return latest;
    if (command === "ticket_evidence_page") return evidence;
    if (command === "change_ticket") {
      if (writeFailure) throw { code: writeFailure, message: "Cannot write." };
      const patch = (
        args as { patch: { status: string; expected_status: string } }
      ).patch;
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

function open(select = vi.fn(), reviewQueue = [ticket]) {
  return render(
    <StatusLineRegion>
      <TestOpenTicket ticket={ticket}>
        <TicketPage
          active
          readReviewQueue={async () => reviewQueue}
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
  expect(document.activeElement).toBe(
    within(card).getByText("Nothing else in review"),
  );
  expect(screen.getByText("Moved T-KQ1 to Done")).toBeTruthy();
  expect(select).not.toHaveBeenCalled();
  expect(bridge.invoke).toHaveBeenCalledWith("change_ticket", {
    reference: "T-KQ1",
    patch: { expected_status: "In review", status: "Done" },
    requestId: expect.any(String),
  });
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(
    await screen.findByRole("region", { name: "Ready for review" }),
  ).toBeTruthy();
  expect(bridge.invoke).toHaveBeenCalledWith("change_ticket", {
    reference: "T-KQ1",
    patch: { expected_status: "Done", status: "In review" },
    requestId: expect.any(String),
  });
});

test("Reply posts an update in the card and keeps the ticket In progress", async () => {
  ticket = { ...review, status: "In progress" };
  open();
  const card = within(
    await screen.findByRole("region", { name: "Latest update" }),
  );
  expect(card.queryByText("Acceptance 1 of 2")).toBeNull();
  fireEvent.click(card.getByRole("button", { name: "Reply" }));
  const field = card.getByRole("textbox", { name: "Reply" });
  expect(document.activeElement).toBe(field);
  fireEvent.change(field, {
    target: { value: "Please include the screenshots." },
  });
  fireEvent.click(card.getByRole("button", { name: "Post update" }));
  expect(await card.findByText("Please include the screenshots.")).toBeTruthy();
  expect(
    screen.getByRole("combobox", { name: "Status: In progress" }),
  ).toBeTruthy();
  expect(bridge.invoke).toHaveBeenCalledWith("add_activity_with_details", {
    reference: "T-KQ1",
    brief: "Please include the screenshots.",
    details: null,
    existingDocumentId: null,
    requestId: expect.any(String),
  });
});

test.each(["Todo", "Done", "Canceled", "Duplicate", "Trash"])(
  "the review and update cards stay out of %s",
  async (status) => {
    ticket = {
      ...review,
      status: status === "Trash" ? "In review" : status,
      trashed: status === "Trash",
    };
    open();
    await screen.findByText("How would you know it worked?");
    expect(
      screen.queryByRole("region", {
        name: /Ready for review|Latest update|Done/,
      }),
    ).toBeNull();
  },
);

test("an unreported review is still actionable and has no empty acceptance count", async () => {
  latest = null;
  ticket = {
    ...review,
    body: `## Acceptance criteria

A paragraph without a checklist.`,
  };
  open();
  const card = within(
    await screen.findByRole("region", { name: "Ready for review" }),
  );
  expect(await card.findByText("No report yet")).toBeTruthy();
  expect(card.queryByRole("button", { name: /Acceptance/ })).toBeNull();
  expect(card.getByRole("button", { name: "Move to Done" })).toBeTruthy();
});

test("Show more expands a long report where the reviewer is reading", async () => {
  latest = update(`First line.

Second line.

Third line.

Fourth line.

Fifth line.`);
  // JSDOM does no layout. Supply a rendered height equivalent to five lines.
  const height = vi
    .spyOn(HTMLElement.prototype, "scrollHeight", "get")
    .mockReturnValue(100);
  try {
    open();
    const card = within(
      await screen.findByRole("region", { name: "Ready for review" }),
    );
    const more = await card.findByRole("button", { name: "Show more" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(
      card
        .getByRole("button", { name: "Show less" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(card.getByText("Fifth line.")).toBeTruthy();
  } finally {
    height.mockRestore();
  }
});

test("review proof leads with the pull request, then verification, then more evidence", async () => {
  const proof = (
    kind: Evidence["kind"],
    name: string,
    value: string,
  ): Evidence => ({
    id: name,
    kind,
    name,
    value,
    created_at: "2026-11-28T03:00:00Z",
    updated_at: "2026-11-28T03:00:00Z",
    editing_agent: null,
  });
  const pr = proof(
    "pull_request",
    "PR #23",
    "https://github.com/example/project/pull/23",
  );
  const checked = proof("verification", "Regression suite", "23 tests passed.");
  const branch = proof("branch", "Implementation branch", "feature/review");
  const commit = proof("commit", "Merge commit", "c0ffee");
  evidence = {
    items: [branch, commit, checked, pr],
    total: 4,
    proof: [pr, checked],
  };
  open();
  const group = within(
    await screen.findByRole("group", { name: "Review evidence" }),
  );
  expect(
    group
      .getByRole("link", { name: "PR #23" })
      .compareDocumentPosition(
        group.getByRole("button", { name: "Regression suite" }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  fireEvent.click(group.getByRole("button", { name: "Regression suite" }));
  expect(
    within(
      await screen.findByRole("dialog", { name: "Regression suite" }),
    ).getByText("23 tests passed."),
  ).toBeTruthy();
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  fireEvent.click(group.getByRole("button", { name: "+2 evidence" }));
  expect(document.activeElement).toBe(
    screen.getByRole("heading", { name: "Evidence 4" }),
  );
  expect(
    screen
      .getByRole("button", { name: /1 more/ })
      .getAttribute("aria-expanded"),
  ).toBe("true");
});

test("a successful decision suggests the next In review ticket, wrapping at the end", async () => {
  const select = vi.fn();
  const ahead = { ...review, reference: "T-KQ2" };
  const behind = { ...review, reference: "T-KQ3" };
  const other = { ...review, reference: "T-KQ4", status: "Todo" };
  open(select, [ahead, other, behind, review]);
  fireEvent.click(await screen.findByRole("button", { name: "Move to Done" }));
  const next = await screen.findByRole("link", { name: "Next to review" });
  expect(document.activeElement).toBe(next);
  expect(select).not.toHaveBeenCalled();
  fireEvent.click(next);
  expect(select).toHaveBeenCalledWith("T-KQ2");
});

test("the shortcut skips a text field and a decision picks the later review before wrapping", async () => {
  const select = vi.fn();
  const earlier = { ...review, reference: "T-KQ2" };
  const later = { ...review, reference: "T-KQ3" };
  const todo = { ...review, reference: "T-KQ4", status: "Todo" };
  open(select, [earlier, review, todo, later]);
  const shortcut = {
    key: "Enter",
    ...(isMacPlatform() ? { metaKey: true } : { ctrlKey: true }),
  };
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Title" }), shortcut);
  expect(
    bridge.invoke.mock.calls.some(([command]) => command === "change_ticket"),
  ).toBe(false);
  fireEvent.keyDown(
    screen.getByRole("heading", { name: "Ready for review" }),
    shortcut,
  );
  fireEvent.click(await screen.findByRole("link", { name: "Next to review" }));
  expect(select).toHaveBeenCalledWith("T-KQ3");
});

test("a rejected write keeps the report and Retry repeats the same decision", async () => {
  writeFailure = "failed";
  open();
  fireEvent.click(await screen.findByRole("button", { name: "Move to Done" }));
  expect(await screen.findByText(/Couldn't move T-KQ1 to Done/)).toBeTruthy();
  expect(screen.getByRole("region", { name: "Ready for review" })).toBeTruthy();
  const first = bridge.invoke.mock.calls.find(
    ([command]) => command === "change_ticket",
  )?.[1];
  writeFailure = null;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("region", { name: "Done" })).toBeTruthy();
  expect(
    bridge.invoke.mock.calls
      .filter(([command]) => command === "change_ticket")
      .at(-1)?.[1],
  ).toEqual(first);
});

test("the write refuses when the ticket was moved elsewhere first", async () => {
  open();
  const move = await screen.findByRole("button", { name: "Move to Done" });
  ticket = { ...review, status: "In progress" };
  fireEvent.click(move);
  expect(
    await screen.findByText(/changed elsewhere since it was loaded/),
  ).toBeTruthy();
  expect(
    await screen.findByRole("region", { name: "Latest update" }),
  ).toBeTruthy();
  expect(screen.queryByText("Moved T-KQ1 to Done")).toBeNull();
});
