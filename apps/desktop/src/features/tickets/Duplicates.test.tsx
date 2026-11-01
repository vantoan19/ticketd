// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { Duplicates } from "@/features/tickets/Duplicates";
import type { Ticket } from "@/lib/api/client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const ticket: Ticket = {
  id: "1",
  reference: "T-1",
  title: "Source",
  body: "",
  status: "Todo",
  trashed: false,
  tags: [],
  project_id: null,
  effort_id: null,
  availability: "Ready",
  parent: null,
  children: [],
  prerequisites: [],
};
const edge = (blocker: string, dependent: string) => ({
  blocker,
  dependent,
  replacement_blocker: blocker === "T-1" ? "T-2" : blocker,
  replacement_dependent: dependent === "T-1" ? "T-2" : dependent,
});
const preview = {
  canonical: "T-2",
  edges: [edge("T-1", "T-3"), edge("T-1", "T-4"), edge("T-5", "T-1")],
  replacement_issues: [null, "already_exists", null],
};
let reviewError: unknown = null;
let current = preview;

beforeEach(() => {
  reviewError = null;
  current = preview;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "preview_duplicate_dependencies") return current;
    if (command === "show_ticket")
      return { ...ticket, id: "2", reference: "T-2", title: "Canonical" };
    if (reviewError) throw reviewError;
    return { ...ticket, status: "Duplicate", duplicate_of: "T-2" };
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function openReview(refresh = vi.fn(async () => {})) {
  render(<Duplicates ticket={ticket} refresh={refresh} />);
  fireEvent.change(screen.getByLabelText("Canonical ticket reference"), {
    target: { value: "T-2" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review dependencies" }));
  await screen.findByText("Affected dependencies");
  return refresh;
}
const choose = (edgeName: string, label: string) =>
  fireEvent.click(
    screen
      .getAllByRole("radiogroup", { name: `Choice for ${edgeName}` })[0]!
      .querySelector(`[role="radio"][value="${label}"]`)!,
  );

test("disables an invalid Replace with the reason", async () => {
  await openReview();
  const group = screen.getByRole("radiogroup", {
    name: "Choice for T-1 blocks T-4",
  });
  expect(
    (group.querySelector('[value="replace"]') as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(
    screen.getByText("Replace unavailable: T-2 already blocks T-4."),
  ).toBeTruthy();
  const open = screen.getByRole("radiogroup", {
    name: "Choice for T-1 blocks T-3",
  });
  expect(
    (open.querySelector('[value="replace"]') as HTMLButtonElement).disabled,
  ).toBe(false);
});

test("the summary and the apply label follow the choices", async () => {
  await openReview();
  const apply = () =>
    screen.getByRole("button", {
      name: /^Mark duplicate/,
    }) as HTMLButtonElement;
  expect(apply().disabled).toBe(true);
  choose("T-1 blocks T-3", "replace");
  choose("T-1 blocks T-4", "retain");
  choose("T-5 blocks T-1", "remove");
  expect(apply().textContent).toBe("Mark duplicate and apply 2 changes");
  expect(apply().disabled).toBe(false);
  expect(
    screen.getByText(
      /Cancel T-1 as a duplicate of T-2, replace 1 dependency, remove 1 dependency, keep 1 dependency/,
    ),
  ).toBeTruthy();
  expect(screen.getByText("T-3 waits for T-2 to be Done instead")).toBeTruthy();
  expect(
    screen.getByText("T-4 stays blocked by a duplicate ticket"),
  ).toBeTruthy();
});

test("applies the duplicate and the chosen changes together", async () => {
  const refresh = await openReview();
  choose("T-1 blocks T-3", "replace");
  choose("T-1 blocks T-4", "retain");
  choose("T-5 blocks T-1", "remove");
  fireEvent.click(
    screen.getByRole("button", { name: "Mark duplicate and apply 2 changes" }),
  );
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  expect(invoke).toHaveBeenCalledWith(
    "mark_duplicate_reviewed",
    expect.objectContaining({
      source: "T-1",
      canonical: "T-2",
      decisions: [
        expect.objectContaining({ choice: "replace" }),
        expect.objectContaining({ choice: "retain" }),
        expect.objectContaining({ choice: "remove" }),
      ],
    }),
  );
});

test("a stale preview keeps the review open, applies nothing, and refreshes on request", async () => {
  const refresh = await openReview();
  choose("T-1 blocks T-3", "replace");
  choose("T-1 blocks T-4", "retain");
  choose("T-5 blocks T-1", "remove");
  reviewError = {
    code: "review_changed",
    index: null,
    message: "dependency review has changed; preview and choose again",
  };
  fireEvent.click(
    screen.getByRole("button", { name: "Mark duplicate and apply 2 changes" }),
  );
  expect(
    await screen.findByText(/Dependencies changed after this preview/),
  ).toBeTruthy();
  expect(refresh).not.toHaveBeenCalled();
  expect(
    (
      screen.getByRole("button", {
        name: /^Mark duplicate/,
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  current = {
    canonical: "T-2",
    edges: [edge("T-1", "T-3"), edge("T-6", "T-1")],
    replacement_issues: [null, null],
  };
  fireEvent.click(screen.getByRole("button", { name: "Refresh preview" }));
  await screen.findByRole("radiogroup", { name: "Choice for T-6 blocks T-1" });
  expect(screen.queryByText(/Dependencies changed after/)).toBeNull();
  expect(
    screen.queryByRole("radiogroup", { name: "Choice for T-5 blocks T-1" }),
  ).toBeNull();
});

test("a ticket with no dependencies can be marked directly", async () => {
  current = { canonical: "T-2", edges: [], replacement_issues: [] };
  render(<Duplicates ticket={ticket} refresh={async () => {}} />);
  fireEvent.change(screen.getByLabelText("Canonical ticket reference"), {
    target: { value: "T-2" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review dependencies" }));
  const apply = await screen.findByRole("button", { name: "Mark duplicate" });
  expect((apply as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByText(/Removing the duplicate link later/)).toBeTruthy();
});

test("reviews separate dependency changes for an existing endpoint", async () => {
  current = {
    canonical: "T-1",
    edges: [{ ...edge("T-9", "T-3"), replacement_blocker: "T-1" }],
    replacement_issues: [null],
  };
  render(<Duplicates ticket={ticket} refresh={async () => {}} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Review separate dependency changes" }),
  );
  fireEvent.change(screen.getByLabelText("Existing endpoint to replace"), {
    target: { value: "T-9" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review dependencies" }));
  await screen.findByText("Affected dependencies");
  choose("T-9 blocks T-3", "replace");
  fireEvent.click(
    screen.getByRole("button", { name: "Apply dependency changes" }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      "edit_dependencies_reviewed",
      expect.objectContaining({ source: "T-9", canonical: "T-1" }),
    ),
  );
});

test("shows both tickets with their statuses, and the duplicate's status change", async () => {
  await openReview();
  expect(screen.getByText("Canonical")).toBeTruthy();
  const duplicate = screen.getByRole("group", { name: "Duplicate" });
  expect(duplicate.textContent).toContain(
    "Todo → Duplicate · Duplicate of T-2",
  );
  const canonical = screen.getByRole("group", { name: "Canonical ticket" });
  expect(canonical.textContent).toContain("Todo · unchanged");
});

test("a separate review does not claim the kept endpoint is a duplicate", async () => {
  current = {
    canonical: "T-1",
    edges: [{ ...edge("T-9", "T-3"), replacement_blocker: "T-1" }],
    replacement_issues: [null],
  };
  render(<Duplicates ticket={ticket} refresh={async () => {}} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Review separate dependency changes" }),
  );
  fireEvent.change(screen.getByLabelText("Existing endpoint to replace"), {
    target: { value: "T-9" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review dependencies" }));
  await screen.findByText("Affected dependencies");
  choose("T-9 blocks T-3", "retain");
  expect(screen.getByText("T-3 stays blocked by T-9")).toBeTruthy();
  expect(screen.queryByText(/duplicate ticket/)).toBeNull();
});
