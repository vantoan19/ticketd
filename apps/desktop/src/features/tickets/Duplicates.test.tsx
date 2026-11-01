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
const edge = (
  blocker: string,
  dependent: string,
  overrides: Record<string, unknown> = {},
) => ({
  blocker,
  dependent,
  replacement_blocker: blocker === "T-1" ? "T-2" : blocker,
  replacement_dependent: dependent === "T-1" ? "T-2" : dependent,
  mode: "duplicate",
  basis: "0123456789abcdef",
  replacement_basis: "fedcba9876543210",
  ...overrides,
});
const preview = {
  source: "T-1",
  mode: "duplicate",
  waiting: [],
  canonical: "T-2",
  edges: [edge("T-1", "T-3"), edge("T-1", "T-4"), edge("T-5", "T-1")],
  replacement_issues: [null, "already_exists", null],
};
let reviewError: unknown = null;
let current: Record<string, unknown> = preview;
let outcomes: unknown[] = [];
let evaluateError: unknown = null;

beforeEach(() => {
  reviewError = null;
  current = preview;
  outcomes = [];
  evaluateError = null;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "preview_duplicate_dependencies") return current;
    if (command === "evaluate_dependency_review") {
      if (evaluateError) throw evaluateError;
      return outcomes;
    }
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
/** The apply button, once the core has answered for the current choices. */
const enabled = async (name: string) => {
  const button = screen.getByRole("button", { name }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  return button;
};
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
  await waitFor(() => expect(apply().disabled).toBe(false));
  expect(
    screen.getByText(
      /Cancel T-1 as a duplicate of T-2, replace 1 dependency, remove 1 dependency, keep 1 dependency/,
    ),
  ).toBeTruthy();
  expect(screen.getByText("T-3 now waits on T-2")).toBeTruthy();
  expect(
    screen.getByText("T-4 keeps waiting on a duplicate ticket"),
  ).toBeTruthy();
});

test("applies the duplicate and the chosen changes together", async () => {
  const refresh = await openReview();
  choose("T-1 blocks T-3", "replace");
  choose("T-1 blocks T-4", "retain");
  choose("T-5 blocks T-1", "remove");
  fireEvent.click(await enabled("Mark duplicate and apply 2 changes"));
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
  fireEvent.click(await enabled("Mark duplicate and apply 2 changes"));
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
    source: "T-1",
    mode: "duplicate",
    waiting: [],
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
  current = {
    source: "T-1",
    mode: "duplicate",
    waiting: [],
    canonical: "T-2",
    edges: [],
    replacement_issues: [],
  };
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
    source: "T-9",
    mode: "separate",
    waiting: [],
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
  fireEvent.click(await enabled("Apply dependency changes"));
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
    source: "T-9",
    mode: "separate",
    waiting: [],
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
  expect(screen.getByText("T-3 keeps waiting on T-9")).toBeTruthy();
  expect(screen.queryByText(/duplicate ticket/)).toBeNull();
});

const outcome = (ticket: string, overrides: Record<string, unknown> = {}) => ({
  ticket,
  status: "Todo",
  trashed: false,
  before: "blocked",
  after: "blocked",
  unresolved_after: [],
  ...overrides,
});

test("each choice words the core's outcome for the whole set of choices", async () => {
  current = {
    source: "T-1",
    mode: "duplicate",
    waiting: [],
    canonical: "T-2",
    edges: [
      edge("T-1", "T-3"),
      edge("T-1", "T-4"),
      edge("T-1", "T-6"),
      edge("T-1", "T-7"),
    ],
    replacement_issues: [null, null, null, null],
  };
  outcomes = [
    outcome("T-3", { after: "ready" }),
    outcome("T-4", { unresolved_after: ["T-8", "T-2"] }),
    outcome("T-6", {
      status: "In progress",
      before: "no_ready_state",
      after: "no_ready_state",
    }),
    outcome("T-7", {
      trashed: true,
      before: "no_ready_state",
      after: "no_ready_state",
    }),
  ];
  await openReview();
  choose("T-1 blocks T-3", "replace");
  expect(
    await screen.findByText(
      "T-3 becomes Ready; it now waits on T-2, which is Done",
    ),
  ).toBeTruthy();
  choose("T-1 blocks T-4", "replace");
  expect(
    await screen.findByText("T-4 stays Blocked, waiting on T-8, T-2"),
  ).toBeTruthy();
  choose("T-1 blocks T-6", "remove");
  expect(
    await screen.findByText(
      "T-6 is In progress and has no Ready state; it no longer waits on T-1",
    ),
  ).toBeTruthy();
  choose("T-1 blocks T-7", "retain");
  expect(
    await screen.findByText(
      "T-7 is in the trash and has no Ready state; it keeps waiting on a duplicate ticket",
    ),
  ).toBeTruthy();
});

test("the canonical's readiness is shown when the duplicate is the dependent", async () => {
  current = {
    source: "T-1",
    mode: "duplicate",
    waiting: [],
    canonical: "T-2",
    edges: [edge("T-5", "T-1")],
    replacement_issues: [null],
  };
  outcomes = [
    outcome("T-1", { after: "no_ready_state" }),
    outcome("T-2", { before: "ready", unresolved_after: ["T-5"] }),
  ];
  await openReview();
  choose("T-5 blocks T-1", "replace");
  expect(
    await screen.findByText("T-2 becomes Blocked until T-5 is Done"),
  ).toBeTruthy();
  choose("T-5 blocks T-1", "retain");
  expect(
    await screen.findByText(
      "T-1 is Duplicate and has no Ready state; it keeps its dependency on T-5",
    ),
  ).toBeTruthy();
  choose("T-5 blocks T-1", "remove");
  expect(
    await screen.findByText(
      "T-1 is Duplicate and has no Ready state; T-5 no longer blocks T-1",
    ),
  ).toBeTruthy();
});

test("the review evaluates every choice together, with unchosen ones kept", async () => {
  await openReview();
  choose("T-1 blocks T-3", "replace");
  await waitFor(() =>
    expect(invoke).toHaveBeenLastCalledWith("evaluate_dependency_review", {
      source: "T-1",
      canonical: "T-2",
      separate: false,
      decisions: [
        expect.objectContaining({ choice: "replace" }),
        expect.objectContaining({ choice: "retain" }),
        expect.objectContaining({ choice: "retain" }),
      ],
    }),
  );
});

test("a review the core calls changed while choosing is stale", async () => {
  await openReview();
  evaluateError = {
    code: "review_changed",
    index: null,
    message: "dependency review has changed; preview and choose again",
  };
  choose("T-1 blocks T-3", "remove");
  expect(
    await screen.findByText(/Dependencies changed after this preview/),
  ).toBeTruthy();
});

test("a separate review compares against the preview's normalized source", async () => {
  current = {
    source: "T-9",
    mode: "separate",
    waiting: [],
    canonical: "T-1",
    edges: [
      { ...edge("T-9", "T-3"), mode: "separate", replacement_blocker: "T-1" },
    ],
    replacement_issues: [null],
  };
  render(<Duplicates ticket={ticket} refresh={async () => {}} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Review separate dependency changes" }),
  );
  fireEvent.change(screen.getByLabelText("Existing endpoint to replace"), {
    target: { value: "T-09" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review dependencies" }));
  await screen.findByText("Affected dependencies");
  choose("T-9 blocks T-3", "retain");
  expect(screen.getByText("T-3 keeps waiting on T-9")).toBeTruthy();
});

test("names the replacement once, in the form of the issue's example", async () => {
  current = {
    ...preview,
    edges: [edge("T-1", "T-63"), edge("T-1", "T-64")],
    replacement_issues: [null, null],
  };
  outcomes = [
    outcome("T-63", { unresolved_after: ["T-2"] }),
    outcome("T-64", { before: "ready", unresolved_after: ["T-2"] }),
  ];
  await openReview();
  choose("T-1 blocks T-63", "replace");
  choose("T-1 blocks T-64", "replace");
  expect(
    await screen.findByText("T-63 becomes Ready once T-2 is Done"),
  ).toBeTruthy();
  expect(
    screen.getByText("T-64 becomes Blocked until T-2 is Done"),
  ).toBeTruthy();
});

test("a late answer for earlier choices never replaces the answer for the latest", async () => {
  current = {
    ...preview,
    edges: [edge("T-1", "T-3")],
    replacement_issues: [null],
  };
  const pending: { replace: boolean; resolve: (value: unknown) => void }[] = [];
  const base = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command !== "evaluate_dependency_review") return base(command, args);
    const decisions = (args as { decisions: { choice: string }[] }).decisions;
    return new Promise((resolve) =>
      pending.push({ replace: decisions[0]?.choice === "replace", resolve }),
    );
  });
  await openReview();
  choose("T-1 blocks T-3", "replace");
  await waitFor(() => expect(pending.length).toBe(2));
  choose("T-1 blocks T-3", "remove");
  await waitFor(() => expect(pending.length).toBe(3));
  pending[2]?.resolve([outcome("T-3", { unresolved_after: ["T-9"] })]);
  expect(
    await screen.findByText(
      "T-3 stays Blocked, waiting on T-9; it no longer waits on T-1",
    ),
  ).toBeTruthy();
  pending[1]?.resolve([outcome("T-3", { after: "ready" })]);
  await new Promise((done) => setTimeout(done, 20));
  expect(screen.queryByText(/T-3 becomes Ready/)).toBeNull();
  expect(screen.getByText(/T-3 stays Blocked, waiting on T-9/)).toBeTruthy();
});

test("a failed evaluate clears the earlier lines and Apply waits for each answer", async () => {
  current = {
    ...preview,
    edges: [edge("T-1", "T-3")],
    replacement_issues: [null],
  };
  outcomes = [outcome("T-3", { after: "ready" })];
  await openReview();
  choose("T-1 blocks T-3", "remove");
  expect(
    await screen.findByText("T-3 becomes Ready; it no longer waits on T-1"),
  ).toBeTruthy();
  const apply = () =>
    screen.getByRole("button", {
      name: /^Mark duplicate/,
    }) as HTMLButtonElement;
  await waitFor(() => expect(apply().disabled).toBe(false));
  evaluateError = {
    code: "failed",
    index: null,
    message: "database is locked",
  };
  choose("T-1 blocks T-3", "retain");
  expect(await screen.findByText("database is locked")).toBeTruthy();
  expect(screen.queryByText(/becomes Ready/)).toBeNull();
  expect(
    screen.getByText("T-3 keeps waiting on a duplicate ticket"),
  ).toBeTruthy();
});

test("Apply is disabled while the answer for the choices is on its way", async () => {
  current = {
    ...preview,
    edges: [edge("T-1", "T-3")],
    replacement_issues: [null],
  };
  let release: (value: unknown) => void = () => {};
  const base = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) =>
    command === "evaluate_dependency_review"
      ? new Promise((resolve) => (release = resolve))
      : base(command, args),
  );
  await openReview();
  choose("T-1 blocks T-3", "remove");
  const apply = screen.getByRole("button", {
    name: /^Mark duplicate/,
  }) as HTMLButtonElement;
  expect(apply.disabled).toBe(true);
  release([outcome("T-3")]);
  await waitFor(() => expect(apply.disabled).toBe(false));
});

test("a preview for the other kind of review offers a refresh with its own message", async () => {
  await openReview();
  evaluateError = {
    code: "review_mode",
    index: null,
    message: "this review was previewed for a different kind of review",
  };
  choose("T-1 blocks T-3", "remove");
  expect(
    await screen.findByText(/made for a different kind of review/),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Refresh preview" })).toBeTruthy();
});

test("a trashed endpoint explains why Replace is unavailable", async () => {
  current = {
    ...preview,
    edges: [edge("T-1", "T-3")],
    replacement_issues: ["trashed"],
  };
  await openReview();
  expect(
    screen.getByText("Replace unavailable: T-2 or T-3 is in the trash."),
  ).toBeTruthy();
});

test("the review kind cannot be switched while a preview is loading", async () => {
  vi.mocked(invoke).mockImplementation(() => new Promise(() => {}));
  render(<Duplicates ticket={ticket} refresh={async () => {}} />);
  fireEvent.change(screen.getByLabelText("Canonical ticket reference"), {
    target: { value: "T-2" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review dependencies" }));
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Review separate dependency changes",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true),
  );
});
