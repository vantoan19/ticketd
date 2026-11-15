// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { syncReview, type ConflictSummary } from "@/lib/sync-review-api";
import { TicketList } from "@/features/tickets/TicketList";
import type { Ticket } from "@/lib/api/client";
import { WorkspaceChangeProvider } from "@/lib/workspace-change";
import { NeedsReviewNotice } from "./NeedsReviewNotice";

vi.mock("@/lib/sync-review-api", () => ({
  syncReview: {
    conflicts: vi.fn(),
    conflict: vi.fn(() => new Promise(() => {})),
  },
}));

const conflict: ConflictSummary = {
  kind: "ticket",
  id: "guid-12",
  reference: "T-KQ12",
  title: "Rate-limit failed login attempts",
  fields: ["status", "body"],
  detected_at: "2026-11-11T18:41:00Z",
  read: false,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test("a record changed on two desktops says so and opens the comparison", async () => {
  vi.mocked(syncReview.conflicts).mockResolvedValue([conflict]);
  render(<NeedsReviewNotice kind="ticket" id="guid-12" />);
  const notice = await screen.findByRole("region", { name: "Needs review" });
  expect(notice.textContent).toContain(
    "Status and Description were changed on two desktops. This desktop’s version is shown until you choose.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  expect(screen.getByRole("dialog", { name: "Review changes" })).toBeTruthy();
  expect(syncReview.conflict).toHaveBeenCalledWith({
    kind: "ticket",
    id: "guid-12",
  });
});

test("a record without a conflict shows no notice, also when sync cannot be read", async () => {
  vi.mocked(syncReview.conflicts).mockRejectedValue(new Error("no sync"));
  render(<NeedsReviewNotice kind="document" id="guid-12" />);
  await vi.waitFor(() => expect(syncReview.conflicts).toHaveBeenCalled());
  expect(screen.queryByRole("region")).toBeNull();
});

const ticket = (id: string, reference: string): Ticket => ({
  id,
  trashed: false,
  reference,
  title: reference,
  status: "Todo",
  body: "",
  tags: [],
  project_id: null,
  plan_id: null,
  availability: "Ready",
  parent: null,
  children: [],
  duplicate_of: null,
  duplicates: [],
  prerequisites: [],
});

test("a ticket row says Needs review in place of its readiness", async () => {
  vi.mocked(syncReview.conflicts).mockResolvedValue([conflict]);
  render(
    <TicketList
      tickets={[ticket("guid-12", "T-KQ12"), ticket("guid-13", "T-KQ13")]}
      selected={null}
      onOpen={vi.fn()}
      bulkSelection={[]}
      onToggle={vi.fn()}
      selectable
      scope={{ showPlan: false, showProject: false, plans: [], projects: [] }}
    />,
  );
  const label = await screen.findByText("Needs review");
  const row = label.closest("li");
  expect(row?.textContent).toContain("T-KQ12");
  expect(row?.textContent).not.toContain("Ready");
  expect(screen.getAllByText("Needs review")).toHaveLength(1);
  expect(screen.queryByText("Ready")).toBeNull();
});

test("conflicts that cannot be read again keep the notice that was showing", async () => {
  vi.mocked(syncReview.conflicts).mockResolvedValue([conflict]);
  const view = (change: number) => (
    <WorkspaceChangeProvider value={change}>
      <NeedsReviewNotice kind="ticket" id="guid-12" />
    </WorkspaceChangeProvider>
  );
  const { rerender } = render(view(0));
  await screen.findByRole("region", { name: "Needs review" });
  vi.mocked(syncReview.conflicts).mockRejectedValue(new Error("busy"));
  rerender(view(1));
  await vi.waitFor(() => expect(syncReview.conflicts).toHaveBeenCalledTimes(2));
  await act(() => new Promise<void>((done) => setTimeout(done)));
  expect(screen.getByRole("region", { name: "Needs review" })).toBeTruthy();
});

test("a comparison stays open when its conflict leaves the list", async () => {
  vi.mocked(syncReview.conflicts).mockResolvedValue([conflict]);
  const view = (change: number) => (
    <WorkspaceChangeProvider value={change}>
      <NeedsReviewNotice kind="ticket" id="guid-12" />
    </WorkspaceChangeProvider>
  );
  const { rerender } = render(view(0));
  fireEvent.click(
    await screen.findByRole("button", { name: "Review changes" }),
  );
  // The comparison reads the list itself, and has seen the conflict on it.
  await waitFor(() => expect(syncReview.conflicts).toHaveBeenCalledTimes(2));
  vi.mocked(syncReview.conflicts).mockResolvedValue([]);
  rerender(view(1));
  expect((await screen.findByRole("status")).textContent).toContain(
    "A newer change settled this",
  );
  expect(screen.queryByRole("region", { name: "Needs review" })).toBeNull();
  expect(screen.getByRole("dialog", { name: "Review changes" })).toBeTruthy();
});
