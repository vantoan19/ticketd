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
import {
  syncReview,
  type Version,
  type VersionSource,
} from "@/lib/sync-review-api";
import { RecordHistory } from "./RecordHistory";

vi.mock("@/lib/sync-review-api", () => ({
  syncReview: { versions: vi.fn(), version: vi.fn(), restore: vi.fn() },
}));

const hours = (n: number) => new Date(Date.now() - n * 3600000).toISOString();
const versions: Version[] = [
  {
    id: "v3",
    timestamp: hours(1),
    device: "Studio desktop",
    changed: ["status"],
  },
  { id: "v2", timestamp: hours(30), device: null, changed: ["body"] },
  { id: "v1", timestamp: hours(24 * 9), device: null, changed: ["created"] },
];

let stored: Record<VersionSource, Version[]>;
const onClose = vi.fn();
const onRestored = vi.fn();
const open = () =>
  render(
    <RecordHistory
      kind="ticket"
      id="guid-12"
      subtitle="T-KQ12 · Rate-limit failed login attempts"
      onClose={onClose}
      onRestored={onRestored}
    />,
  );

beforeEach(() => {
  stored = { local: versions, drive: [] };
  vi.mocked(syncReview.versions).mockImplementation(
    async ({ source }) => stored[source],
  );
  vi.mocked(syncReview.version).mockImplementation(async (_key, version) => ({
    fields:
      version === "v3"
        ? [{ field: "status", value: "In progress", current: "In review" }]
        : [
            {
              field: "body",
              value: "Limit logins per account only.",
              current: "Limit logins per account and IP address.",
            },
          ],
  }));
  vi.mocked(syncReview.restore).mockResolvedValue();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test("lists versions, compares the newest earlier one with now, and restores it", async () => {
  open();
  const list = within(
    await screen.findByRole("navigation", { name: "Versions" }),
  );
  expect(list.getByRole("button", { name: /Current version/ })).toBeTruthy();
  const newest = list.getByRole("button", { name: /Studio desktop · Status/ });
  expect(newest.getAttribute("aria-current")).toBe("true");
  expect(
    list.getByRole("button", { name: /This desktop · Created/ }),
  ).toBeTruthy();
  expect(await screen.findByText("In progress")).toBeTruthy();
  expect(screen.getByText("In review")).toBeTruthy();
  expect(screen.getByText(/Kept for 30 days/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  await waitFor(() => expect(onRestored).toHaveBeenCalled());
  expect(syncReview.restore).toHaveBeenCalledWith(
    { kind: "ticket", id: "guid-12", source: "local" },
    "v3",
  );
  expect(onClose).toHaveBeenCalled();
});

test("choosing a version shows what changed since; the current version cannot be restored", async () => {
  open();
  fireEvent.click(
    await screen.findByRole("button", { name: /This desktop · Description/ }),
  );
  const removed = await screen.findByText("only.");
  expect(removed.tagName).toBe("DEL");
  expect(screen.getByText("and IP address.").tagName).toBe("INS");
  fireEvent.click(screen.getByRole("button", { name: /Current version/ }));
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Restore" }).disabled,
  ).toBe(true);
});

test("a desktop without local versions loads them from Google Drive and says so", async () => {
  let deliver: (found: Version[]) => void = () => {};
  stored.local = [];
  vi.mocked(syncReview.versions).mockImplementation(({ source }) =>
    source === "local"
      ? Promise.resolve([])
      : new Promise((resolve) => (deliver = resolve)),
  );
  open();
  expect(
    await screen.findByRole("status", {
      name: "Loading versions from Google Drive",
    }),
  ).toBeTruthy();
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Restore" }).disabled,
  ).toBe(true);
  deliver([versions[1]!]);
  await screen.findByRole("button", { name: /This desktop · Description/ });
  expect(screen.getByText(/From Google Drive/)).toBeTruthy();
  await waitFor(() =>
    expect(syncReview.version).toHaveBeenCalledWith(
      { kind: "ticket", id: "guid-12", source: "drive" },
      "v2",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  await waitFor(() =>
    expect(syncReview.restore).toHaveBeenCalledWith(
      { kind: "ticket", id: "guid-12", source: "drive" },
      "v2",
    ),
  );
});

test("no versions anywhere is an empty state with nothing to restore", async () => {
  stored.local = [];
  open();
  expect(await screen.findByText("No earlier versions")).toBeTruthy();
  expect(
    screen.getByText(
      "A version is kept each time this ticket changes, for 30 days.",
    ),
  ).toBeTruthy();
  expect(screen.getByText("Nothing to restore yet")).toBeTruthy();
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Restore" }).disabled,
  ).toBe(true);
});

test("a Drive listing that fails is reported, not shown as no versions", async () => {
  vi.mocked(syncReview.versions).mockImplementation(({ source }) =>
    source === "local"
      ? Promise.resolve([])
      : Promise.reject(
          new Error("Could not load versions from Google Drive: offline"),
        ),
  );
  open();
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Could not load versions from Google Drive: offline",
  );
  expect(screen.queryByText("No earlier versions")).toBeNull();
});
