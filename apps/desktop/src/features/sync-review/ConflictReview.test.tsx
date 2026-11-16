import { revealFailureDetails } from "@/test/failure-details";
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BridgeFailure } from "@/lib/api/bridge-failure";
import { syncReview, type Conflict } from "@/lib/sync-review-api";
import { WorkspaceChangeProvider } from "@/lib/workspace-change";
import { ConflictReview } from "./ConflictReview";
import { dayTime } from "./labels";

vi.mock("@/lib/sync-review-api", () => ({
  syncReview: { conflict: vi.fn(), conflicts: vi.fn(), resolve: vi.fn() },
}));

window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const conflict: Conflict = {
  kind: "ticket",
  id: "guid-12",
  reference: "T-KQ12",
  title: "Rate-limit failed login attempts",
  detected_at: "2026-11-11T18:41:00Z",
  read: false,
  local_device: "Laptop",
  fields: [
    {
      field: "status",
      section: null,
      local: "In review",
      local_changed_at: "2026-11-11T18:31:00Z",
      remote: "Done",
      remote_changed_at: "2026-11-11T18:28:00Z",
      remote_device: "Studio desktop",
      detected_at: "2026-11-11T18:41:00Z",
    },
    {
      field: "body",
      section: null,
      local: "Allow 5 failed attempts",
      local_changed_at: "2026-11-11T18:31:00Z",
      remote: "Allow 10 failed attempts",
      remote_changed_at: "2026-11-11T18:28:00Z",
      remote_device: "Studio desktop",
      detected_at: "2026-11-11T18:41:00Z",
    },
  ],
};
const summary = { ...conflict, fields: ["status", "body"] };
const shown = conflict.fields[0]!.detected_at;

const onClose = vi.fn();
const onResolved = vi.fn();
const open = () =>
  render(
    <ConflictReview
      conflict={summary}
      onClose={onClose}
      onResolved={onResolved}
    />,
  );

beforeEach(() => {
  vi.mocked(syncReview.conflict).mockResolvedValue(conflict);
  vi.mocked(syncReview.conflicts).mockResolvedValue([summary]);
  vi.mocked(syncReview.resolve).mockResolvedValue();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test("this desktop's value is preselected and saving keeps it", async () => {
  open();
  const local = await screen.findByRole("radio", {
    name: "Status from this desktop: In review",
  });
  expect(local.getAttribute("aria-checked")).toBe("true");
  expect(
    screen
      .getByRole("radio", { name: "Description from this desktop" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect(screen.getByText("Studio desktop")).toBeTruthy();
  expect(syncReview.conflict).toHaveBeenCalledWith({
    kind: "ticket",
    id: "guid-12",
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onResolved).toHaveBeenCalled());
  expect(syncReview.resolve).toHaveBeenCalledWith(
    { kind: "ticket", id: "guid-12" },
    [
      { field: "status", choice: "local", detected_at: shown },
      { field: "body", choice: "local", detected_at: shown },
    ],
    expect.any(String),
  );
  expect(onClose).toHaveBeenCalled();
});

test("a side is picked per field and the Description can be edited instead", async () => {
  open();
  fireEvent.click(
    await screen.findByRole("radio", {
      name: "Status from Studio desktop: Done",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit instead" }));
  const editor = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Edited description",
  });
  // The edit starts from the side that was selected.
  expect(editor.value).toBe("Allow 5 failed attempts");
  expect(
    screen
      .getByRole("radio", { name: "Your edited description" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  fireEvent.change(editor, { target: { value: "Allow 7 failed attempts" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(syncReview.resolve).toHaveBeenCalledWith(
      { kind: "ticket", id: "guid-12" },
      [
        { field: "status", choice: "remote", detected_at: shown },
        {
          field: "body",
          choice: "edited",
          value: "Allow 7 failed attempts",
          detected_at: shown,
        },
      ],
      expect.any(String),
    ),
  );
});

test("the words that differ between the two sides are marked", async () => {
  open();
  const remote = await screen.findByRole("radio", {
    name: "Description from Studio desktop",
  });
  expect(remote.querySelector("ins")?.textContent).toBe("10");
});

test("Later closes without deciding, and a failed save stays open with its reason", async () => {
  vi.mocked(syncReview.resolve).mockRejectedValue(new Error("disk is full"));
  open();
  await screen.findByRole("radio", { name: /Status from this desktop/ });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await revealFailureDetails();
  expect(screen.getByRole("alert").textContent).toContain("disk is full");
  expect(onResolved).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Later" }));
  expect(onClose).toHaveBeenCalled();
});

test("a side with no recorded change time shows when the conflict was found", async () => {
  vi.mocked(syncReview.conflict).mockResolvedValue({
    ...conflict,
    fields: conflict.fields.map((field) => ({
      ...field,
      local_changed_at: null,
      remote_changed_at: null,
    })),
  });
  open();
  await screen.findByRole("radio", {
    name: "Status from this desktop: In review",
  });
  const found = dayTime(conflict.detected_at, new Date());
  expect(screen.getByText(found)).toBeTruthy();
  expect(
    screen.getByText((_, element) =>
      Boolean(
        element?.tagName === "SPAN" &&
        element.textContent ===
          `Laptop · ${found.replace(/^[TY]/, (letter) => letter.toLowerCase())}`,
      ),
    ),
  ).toBeTruthy();
});

test("a field inside an Activity is named by the Activity, and its text can be edited", async () => {
  const reported = new Date().toISOString();
  vi.mocked(syncReview.conflict).mockResolvedValue({
    ...conflict,
    fields: [
      {
        ...conflict.fields[1]!,
        field: "0c8f3a51-6f0e-4a0b-9d55-2f1f6f3f8a10:body",
        section: { kind: "activity", reported_at: reported, name: null },
      },
    ],
  });
  open();
  expect(await screen.findByText("Activity from Today: text")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Edit instead" })).toBeTruthy();
});

test("each edited text keeps its own words when two are edited and saved", async () => {
  const activity = "0c8f3a51-6f0e-4a0b-9d55-2f1f6f3f8a10:body";
  vi.mocked(syncReview.conflict).mockResolvedValue({
    ...conflict,
    fields: [
      conflict.fields[1]!,
      {
        ...conflict.fields[1]!,
        field: activity,
        section: {
          kind: "activity",
          reported_at: new Date().toISOString(),
          name: null,
        },
        local: "Started here",
        remote: "Started there",
      },
    ],
  });
  open();
  await screen.findByRole("radio", { name: "Description from this desktop" });
  for (const button of screen.getAllByRole("button", { name: "Edit instead" }))
    fireEvent.click(button);
  const description = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Edited description",
  });
  const text = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Edited activity from today: text",
  });
  // Opening the second editor leaves the first one's text alone.
  expect(description.value).toBe("Allow 5 failed attempts");
  expect(text.value).toBe("Started here");
  fireEvent.change(description, { target: { value: "Allow 7" } });
  fireEvent.change(text, { target: { value: "Started everywhere" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(syncReview.resolve).toHaveBeenCalledWith(
      { kind: "ticket", id: "guid-12" },
      [
        {
          field: "body",
          choice: "edited",
          value: "Allow 7",
          detected_at: shown,
        },
        {
          field: activity,
          choice: "edited",
          value: "Started everywhere",
          detected_at: shown,
        },
      ],
      expect.any(String),
    ),
  );
});

test("Save cannot be submitted twice, and saving the same choices again is the same request", async () => {
  vi.mocked(syncReview.resolve).mockRejectedValueOnce(
    new Error("the answer was lost"),
  );
  open();
  await screen.findByRole("radio", { name: /Status from this desktop/ });
  const save = screen.getByRole("button", { name: "Save" });
  fireEvent.submit(save);
  fireEvent.submit(save);
  await screen.findByRole("alert");
  expect(syncReview.resolve).toHaveBeenCalledTimes(1);
  fireEvent.click(save);
  await waitFor(() => expect(onResolved).toHaveBeenCalled());
  const [first, second] = vi.mocked(syncReview.resolve).mock.calls;
  expect(first?.[2]).toBeTruthy();
  expect(second?.[2]).toBe(first?.[2]);
});

test("values that changed during the review are loaded again and nothing is saved", async () => {
  vi.mocked(syncReview.resolve).mockRejectedValueOnce(
    new BridgeFailure("review_changed", "the values to review changed"),
  );
  open();
  fireEvent.click(
    await screen.findByRole("radio", {
      name: "Status from Studio desktop: Done",
    }),
  );
  const later = "2026-11-11T19:02:00Z";
  vi.mocked(syncReview.conflict).mockResolvedValue({
    ...conflict,
    fields: [
      { ...conflict.fields[0]!, remote: "Canceled", detected_at: later },
    ],
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  expect((await screen.findByRole("alert")).textContent).toContain(
    "changed while you were reviewing",
  );
  // The other side's new value is shown, and the choice made on the old one is gone.
  const local = await screen.findByRole("radio", {
    name: "Status from this desktop: In review",
  });
  expect(local.getAttribute("aria-checked")).toBe("true");
  expect(
    screen.getByRole("radio", { name: "Status from Studio desktop: Canceled" }),
  ).toBeTruthy();
  expect(onResolved).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onResolved).toHaveBeenCalled());
  expect(syncReview.resolve).toHaveBeenLastCalledWith(
    { kind: "ticket", id: "guid-12" },
    [{ field: "status", choice: "local", detected_at: later }],
    expect.any(String),
  );
});

test("a review whose values were all settled meanwhile says so and offers nothing to save", async () => {
  vi.mocked(syncReview.resolve).mockRejectedValueOnce(
    new BridgeFailure("review_changed", "the values to review changed"),
  );
  open();
  await screen.findByRole("radio", { name: /Status from this desktop/ });
  vi.mocked(syncReview.conflict).mockRejectedValue(new Error("not found"));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  expect((await screen.findByRole("alert")).textContent).toContain(
    "Nothing is left to review",
  );
  expect(screen.queryByRole("radio")).toBeNull();
  expect(onResolved).toHaveBeenCalled();
});

test("the keyboard starts on the first choice, and reaches Save before Later", async () => {
  open();
  const first = await screen.findByRole("radio", {
    name: "Status from this desktop: In review",
  });
  await waitFor(() => expect(document.activeElement).toBe(first));
  const save = screen.getByRole("button", { name: "Save" });
  const later = screen.getByRole("button", { name: "Later" });
  expect(
    first.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    save.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test("a review that a newer change settles while open says so and stays open", async () => {
  const view = (change: number) => (
    <WorkspaceChangeProvider value={change}>
      <ConflictReview conflict={summary} onClose={onClose} />
    </WorkspaceChangeProvider>
  );
  const { rerender } = render(view(0));
  await screen.findByRole("radio", { name: /Status from this desktop/ });
  vi.mocked(syncReview.conflicts).mockResolvedValue([]);
  rerender(view(1));
  expect((await screen.findByRole("status")).textContent).toContain(
    "A newer change settled this while it was open",
  );
  expect(screen.queryByRole("radio")).toBeNull();
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled,
  ).toBe(true);
  // Nothing is left to put off.
  expect(screen.queryByRole("button", { name: "Later" })).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
});
