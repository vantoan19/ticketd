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
  reference: "T-KQ1",
  title: "Source",
  body: "",
  status: "Todo",
  trashed: false,
  tags: [],
  project_id: null,
  plan_id: null,
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
  replacement_blocker: blocker === "T-KQ1" ? "T-KQ2" : blocker,
  replacement_dependent: dependent === "T-KQ1" ? "T-KQ2" : dependent,
  mode: "duplicate",
  basis: "0123456789abcdef",
  replacement_basis: "fedcba9876543210",
  ...overrides,
});
const preview = {
  source: "T-KQ1",
  mode: "duplicate",
  waiting: [],
  canonical: "T-KQ2",
  edges: [
    edge("T-KQ1", "T-KQ3"),
    edge("T-KQ1", "T-KQ4"),
    edge("T-KQ5", "T-KQ1"),
  ],
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
      return { ...ticket, id: "2", reference: "T-KQ2", title: "Canonical" };
    if (reviewError) throw reviewError;
    return { ...ticket, status: "Duplicate", duplicate_of: "T-KQ2" };
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderReview(
  refresh: () => Promise<void>,
  props: { startSeparate?: boolean } = {},
) {
  return render(
    <Duplicates
      ticket={ticket}
      refresh={refresh}
      open
      onOpenChange={() => {}}
      title="Mark T-KQ2 as a duplicate"
      description="Choose the canonical ticket and review its dependencies."
      {...props}
    />,
  );
}
/** Reviews the typed reference; the chooser has no separate Review button. */
function submitReview() {
  fireEvent.keyDown(
    screen.getByRole("textbox", { name: /ticket reference|endpoint/ }),
    { key: "Enter" },
  );
}

async function openReview(refresh = vi.fn(async () => {})) {
  renderReview(refresh);
  fireEvent.change(screen.getByLabelText("Canonical ticket reference"), {
    target: { value: "T-KQ2" },
  });
  submitReview();
  await screen.findByText("Dependencies to review");
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
    name: "Choice for T-KQ1 blocks T-KQ4",
  });
  expect(
    (group.querySelector('[value="replace"]') as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(
    screen.getByText("Replace unavailable: T-KQ2 already blocks T-KQ4."),
  ).toBeTruthy();
  const open = screen.getByRole("radiogroup", {
    name: "Choice for T-KQ1 blocks T-KQ3",
  });
  expect(
    (open.querySelector('[value="replace"]') as HTMLButtonElement).disabled,
  ).toBe(false);
});

test("a waiting ticket that is itself a Duplicate does not break the review", async () => {
  // T-KQ2 was marked a duplicate earlier and kept its dependency, which is a supported state.
  current = {
    ...preview,
    waiting: [
      {
        ticket: "T-KQ3",
        status: "Duplicate",
        trashed: false,
        readiness: "no_ready_state",
        unresolved: ["T-KQ1"],
      },
    ],
  };
  await openReview();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("Dependencies to review")).toBeTruthy();
});

test("the summary and the apply label follow the choices", async () => {
  await openReview();
  const apply = () =>
    screen.getByRole("button", {
      name: /^Mark duplicate/,
    }) as HTMLButtonElement;
  expect(apply().disabled).toBe(true);
  choose("T-KQ1 blocks T-KQ3", "replace");
  choose("T-KQ1 blocks T-KQ4", "retain");
  choose("T-KQ5 blocks T-KQ1", "remove");
  expect(apply().textContent).toBe("Mark duplicate and apply 2 changes");
  await waitFor(() => expect(apply().disabled).toBe(false));
  expect(
    screen.getByText(
      /Mark T-KQ1 as a duplicate of T-KQ2, replace 1 dependency, remove 1 dependency, keep 1 dependency/,
    ),
  ).toBeTruthy();
  expect(screen.getByText("T-KQ3 now waits on T-KQ2")).toBeTruthy();
  expect(
    screen.getByText("T-KQ4 keeps waiting on a duplicate ticket"),
  ).toBeTruthy();
});

test("applies the duplicate and the chosen changes together", async () => {
  const refresh = await openReview();
  choose("T-KQ1 blocks T-KQ3", "replace");
  choose("T-KQ1 blocks T-KQ4", "retain");
  choose("T-KQ5 blocks T-KQ1", "remove");
  fireEvent.click(await enabled("Mark duplicate and apply 2 changes"));
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  expect(invoke).toHaveBeenCalledWith(
    "mark_duplicate_reviewed",
    expect.objectContaining({
      source: "T-KQ1",
      canonical: "T-KQ2",
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
  choose("T-KQ1 blocks T-KQ3", "replace");
  choose("T-KQ1 blocks T-KQ4", "retain");
  choose("T-KQ5 blocks T-KQ1", "remove");
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
    source: "T-KQ1",
    mode: "duplicate",
    waiting: [],
    canonical: "T-KQ2",
    edges: [edge("T-KQ1", "T-KQ3"), edge("T-KQ6", "T-KQ1")],
    replacement_issues: [null, null],
  };
  fireEvent.click(screen.getByRole("button", { name: "Refresh preview" }));
  await screen.findByRole("radiogroup", {
    name: "Choice for T-KQ6 blocks T-KQ1",
  });
  expect(screen.queryByText(/Dependencies changed after/)).toBeNull();
  expect(
    screen.queryByRole("radiogroup", { name: "Choice for T-KQ5 blocks T-KQ1" }),
  ).toBeNull();
});

test("a ticket with no dependencies can be marked directly", async () => {
  current = {
    source: "T-KQ1",
    mode: "duplicate",
    waiting: [],
    canonical: "T-KQ2",
    edges: [],
    replacement_issues: [],
  };
  renderReview(async () => {});
  fireEvent.change(screen.getByLabelText("Canonical ticket reference"), {
    target: { value: "T-KQ2" },
  });
  submitReview();
  const apply = await screen.findByRole("button", { name: "Mark duplicate" });
  expect((apply as HTMLButtonElement).disabled).toBe(false);
});

test("reviews separate dependency changes for an existing endpoint", async () => {
  current = {
    source: "T-KQ9",
    mode: "separate",
    waiting: [],
    canonical: "T-KQ1",
    edges: [{ ...edge("T-KQ9", "T-KQ3"), replacement_blocker: "T-KQ1" }],
    replacement_issues: [null],
  };
  renderReview(async () => {}, { startSeparate: true });
  fireEvent.change(screen.getByLabelText("Existing endpoint to replace"), {
    target: { value: "T-KQ9" },
  });
  submitReview();
  await screen.findByText("Dependencies to review");
  choose("T-KQ9 blocks T-KQ3", "replace");
  fireEvent.click(await enabled("Apply dependency changes"));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      "edit_dependencies_reviewed",
      expect.objectContaining({ source: "T-KQ9", canonical: "T-KQ1" }),
    ),
  );
});

test("shows both tickets with their statuses, and the duplicate's status change", async () => {
  await openReview();
  const duplicate = screen.getByRole("group", { name: "Duplicate" });
  expect(duplicate.textContent).toContain(
    "Result: T-KQ1 becomes Duplicate of T-KQ2",
  );
  const canonical = screen.getByRole("group", { name: "Canonical ticket" });
  expect(canonical.textContent).toContain("T-KQ2");
});

test("a separate review does not claim the kept endpoint is a duplicate", async () => {
  current = {
    source: "T-KQ9",
    mode: "separate",
    waiting: [],
    canonical: "T-KQ1",
    edges: [{ ...edge("T-KQ9", "T-KQ3"), replacement_blocker: "T-KQ1" }],
    replacement_issues: [null],
  };
  renderReview(async () => {}, { startSeparate: true });
  fireEvent.change(screen.getByLabelText("Existing endpoint to replace"), {
    target: { value: "T-KQ9" },
  });
  submitReview();
  await screen.findByText("Dependencies to review");
  choose("T-KQ9 blocks T-KQ3", "retain");
  expect(screen.getByText("T-KQ3 keeps waiting on T-KQ9")).toBeTruthy();
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
    source: "T-KQ1",
    mode: "duplicate",
    waiting: [],
    canonical: "T-KQ2",
    edges: [
      edge("T-KQ1", "T-KQ3"),
      edge("T-KQ1", "T-KQ4"),
      edge("T-KQ1", "T-KQ6"),
      edge("T-KQ1", "T-KQ7"),
    ],
    replacement_issues: [null, null, null, null],
  };
  outcomes = [
    outcome("T-KQ3", { after: "ready" }),
    outcome("T-KQ4", { unresolved_after: ["T-KQ8", "T-KQ2"] }),
    outcome("T-KQ6", {
      status: "In progress",
      before: "no_ready_state",
      after: "no_ready_state",
    }),
    outcome("T-KQ7", {
      trashed: true,
      before: "no_ready_state",
      after: "no_ready_state",
    }),
  ];
  await openReview();
  choose("T-KQ1 blocks T-KQ3", "replace");
  expect(
    await screen.findByText(
      "T-KQ3 becomes Ready; it now waits on T-KQ2, which is Done",
    ),
  ).toBeTruthy();
  choose("T-KQ1 blocks T-KQ4", "replace");
  expect(
    await screen.findByText("T-KQ4 stays Blocked, waiting on T-KQ8, T-KQ2"),
  ).toBeTruthy();
  choose("T-KQ1 blocks T-KQ6", "remove");
  expect(
    await screen.findByText(
      "T-KQ6 is In progress and has no Ready state; it no longer waits on T-KQ1",
    ),
  ).toBeTruthy();
  choose("T-KQ1 blocks T-KQ7", "retain");
  expect(
    await screen.findByText(
      "T-KQ7 is in the trash and has no Ready state; it keeps waiting on a duplicate ticket",
    ),
  ).toBeTruthy();
});

test("the canonical's readiness is shown when the duplicate is the dependent", async () => {
  current = {
    source: "T-KQ1",
    mode: "duplicate",
    waiting: [],
    canonical: "T-KQ2",
    edges: [edge("T-KQ5", "T-KQ1")],
    replacement_issues: [null],
  };
  outcomes = [
    outcome("T-KQ1", { after: "no_ready_state" }),
    outcome("T-KQ2", { before: "ready", unresolved_after: ["T-KQ5"] }),
  ];
  await openReview();
  choose("T-KQ5 blocks T-KQ1", "replace");
  expect(
    await screen.findByText("T-KQ2 becomes Blocked until T-KQ5 is Done"),
  ).toBeTruthy();
  choose("T-KQ5 blocks T-KQ1", "retain");
  expect(
    await screen.findByText(
      "T-KQ1 is Duplicate and has no Ready state; it keeps its dependency on T-KQ5",
    ),
  ).toBeTruthy();
  choose("T-KQ5 blocks T-KQ1", "remove");
  expect(
    await screen.findByText(
      "T-KQ1 is Duplicate and has no Ready state; T-KQ5 no longer blocks T-KQ1",
    ),
  ).toBeTruthy();
});

test("the review evaluates every choice together, with unchosen ones kept", async () => {
  await openReview();
  choose("T-KQ1 blocks T-KQ3", "replace");
  await waitFor(() =>
    expect(invoke).toHaveBeenLastCalledWith("evaluate_dependency_review", {
      source: "T-KQ1",
      canonical: "T-KQ2",
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
  choose("T-KQ1 blocks T-KQ3", "remove");
  expect(
    await screen.findByText(/Dependencies changed after this preview/),
  ).toBeTruthy();
});

test("a separate review compares against the preview's normalized source", async () => {
  current = {
    source: "T-KQ9",
    mode: "separate",
    waiting: [],
    canonical: "T-KQ1",
    edges: [
      {
        ...edge("T-KQ9", "T-KQ3"),
        mode: "separate",
        replacement_blocker: "T-KQ1",
      },
    ],
    replacement_issues: [null],
  };
  renderReview(async () => {}, { startSeparate: true });
  fireEvent.change(screen.getByLabelText("Existing endpoint to replace"), {
    target: { value: "T-09" },
  });
  submitReview();
  await screen.findByText("Dependencies to review");
  choose("T-KQ9 blocks T-KQ3", "retain");
  expect(screen.getByText("T-KQ3 keeps waiting on T-KQ9")).toBeTruthy();
});

test("names the replacement once, in the form of the issue's example", async () => {
  current = {
    ...preview,
    edges: [edge("T-KQ1", "T-KQ63"), edge("T-KQ1", "T-KQ64")],
    replacement_issues: [null, null],
  };
  outcomes = [
    outcome("T-KQ63", { unresolved_after: ["T-KQ2"] }),
    outcome("T-KQ64", { before: "ready", unresolved_after: ["T-KQ2"] }),
  ];
  await openReview();
  choose("T-KQ1 blocks T-KQ63", "replace");
  choose("T-KQ1 blocks T-KQ64", "replace");
  expect(
    await screen.findByText("T-KQ63 becomes Ready once T-KQ2 is Done"),
  ).toBeTruthy();
  expect(
    screen.getByText("T-KQ64 becomes Blocked until T-KQ2 is Done"),
  ).toBeTruthy();
});

test("a late answer for earlier choices never replaces the answer for the latest", async () => {
  current = {
    ...preview,
    edges: [edge("T-KQ1", "T-KQ3")],
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
  choose("T-KQ1 blocks T-KQ3", "replace");
  await waitFor(() => expect(pending.length).toBe(2));
  choose("T-KQ1 blocks T-KQ3", "remove");
  await waitFor(() => expect(pending.length).toBe(3));
  pending[2]?.resolve([outcome("T-KQ3", { unresolved_after: ["T-KQ9"] })]);
  expect(
    await screen.findByText(
      "T-KQ3 stays Blocked, waiting on T-KQ9; it no longer waits on T-KQ1",
    ),
  ).toBeTruthy();
  pending[1]?.resolve([outcome("T-KQ3", { after: "ready" })]);
  await new Promise((done) => setTimeout(done, 20));
  expect(screen.queryByText(/T-KQ3 becomes Ready/)).toBeNull();
  expect(
    screen.getByText(/T-KQ3 stays Blocked, waiting on T-KQ9/),
  ).toBeTruthy();
});

test("a failed evaluate clears the earlier lines and Apply waits for each answer", async () => {
  current = {
    ...preview,
    edges: [edge("T-KQ1", "T-KQ3")],
    replacement_issues: [null],
  };
  outcomes = [outcome("T-KQ3", { after: "ready" })];
  await openReview();
  choose("T-KQ1 blocks T-KQ3", "remove");
  expect(
    await screen.findByText("T-KQ3 becomes Ready; it no longer waits on T-KQ1"),
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
  choose("T-KQ1 blocks T-KQ3", "retain");
  expect(await screen.findByText(/Database is locked\./)).toBeTruthy();
  expect(screen.queryByText(/becomes Ready/)).toBeNull();
  expect(
    screen.getByText("T-KQ3 keeps waiting on a duplicate ticket"),
  ).toBeTruthy();
});

test("a reference that names no ticket says so in plain words on the field", async () => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "preview_duplicate_dependencies")
      throw { code: "not_found", message: "ticket 'T-ZZ99' was not found" };
    return [];
  });
  renderReview(vi.fn(async () => {}));
  const input = screen.getByLabelText("Canonical ticket reference");
  fireEvent.change(input, { target: { value: "t-zz99" } });
  submitReview();
  expect(await screen.findByText("No ticket T-ZZ99.")).toBeTruthy();
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(screen.queryByText(/was not found/)).toBeNull();
});

test("Apply is disabled while the answer for the choices is on its way", async () => {
  current = {
    ...preview,
    edges: [edge("T-KQ1", "T-KQ3")],
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
  choose("T-KQ1 blocks T-KQ3", "remove");
  const apply = screen.getByRole("button", {
    name: /^Mark duplicate/,
  }) as HTMLButtonElement;
  expect(apply.disabled).toBe(true);
  release([outcome("T-KQ3")]);
  await waitFor(() => expect(apply.disabled).toBe(false));
});

test("a preview for the other kind of review offers a refresh with its own message", async () => {
  await openReview();
  evaluateError = {
    code: "review_mode",
    index: null,
    message: "this review was previewed for a different kind of review",
  };
  choose("T-KQ1 blocks T-KQ3", "remove");
  expect(
    await screen.findByText(/made for a different kind of review/),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Refresh preview" })).toBeTruthy();
});

test("a trashed endpoint explains why Replace is unavailable", async () => {
  current = {
    ...preview,
    edges: [edge("T-KQ1", "T-KQ3")],
    replacement_issues: ["trashed"],
  };
  await openReview();
  expect(
    screen.getByText("Replace unavailable: T-KQ2 or T-KQ3 is in the trash."),
  ).toBeTruthy();
});

test("one flow in the dialog shell: Cancel, and a primary that waits for a canonical ticket", async () => {
  renderReview(async () => {});
  expect(
    screen.getByRole("dialog", { name: "Mark T-KQ2 as a duplicate" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Review dependencies" }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", {
      name: "Review separate dependency changes",
    }),
  ).toBeNull();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  const primary = screen.getByRole("button", { name: "Mark duplicate" });
  expect((primary as HTMLButtonElement).disabled).toBe(true);
  expect(
    screen.getByText("Choose the canonical ticket to review"),
  ).toBeTruthy();
});

test("the primary names what it applies and waits for every dependency choice", async () => {
  await openReview();
  expect(
    await screen.findByText(
      "Choose Replace, Keep or Remove for each dependency",
    ),
  ).toBeTruthy();
  choose("T-KQ1 blocks T-KQ3", "remove");
  expect(
    await screen.findByRole("button", {
      name: "Mark duplicate and apply 1 change",
    }),
  ).toBeTruthy();
});
