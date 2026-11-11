// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { syncReview, type Conflict } from "@/lib/sync-review-api";
import { ConflictReview } from "./ConflictReview";
import { dayTime } from "./labels";

vi.mock("@/lib/sync-review-api", () => ({
  syncReview: { conflict: vi.fn(), resolve: vi.fn() },
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
    },
    {
      field: "body",
      section: null,
      local: "Allow 5 failed attempts",
      local_changed_at: "2026-11-11T18:31:00Z",
      remote: "Allow 10 failed attempts",
      remote_changed_at: "2026-11-11T18:28:00Z",
      remote_device: "Studio desktop",
    },
  ],
};
const summary = { ...conflict, fields: ["status", "body"] };

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
      { field: "status", choice: "local" },
      { field: "body", choice: "local" },
    ],
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
        { field: "status", choice: "remote" },
        { field: "body", choice: "edited", value: "Allow 7 failed attempts" },
      ],
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
  expect((await screen.findByRole("alert")).textContent).toContain(
    "disk is full",
  );
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
