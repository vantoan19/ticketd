// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  syncReview,
  type Version,
  type VersionSource,
} from "@/lib/sync-review-api";
import { SyncStatusContext } from "@/features/sync/sync-status";
import { syncStatus } from "@/features/sync/sync-fixtures";
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
  // The oldest kept version: nothing records which desktop it came from.
  {
    id: "v1",
    timestamp: hours(24 * 9),
    device: null,
    changed: ["title", "body"],
    oldest: true,
  },
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
  stored = { local: versions, drive: [], s3: [] };
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
  expect(
    list.getByRole("button", { name: /Current version/ }).textContent,
  ).toBe("Current versionOn this desktop now");
  const newest = list.getByRole("button", { name: /Studio desktop · Status/ });
  expect(newest.getAttribute("aria-current")).toBe("true");
  expect(
    list.getByRole("button", {
      name: /Earliest version kept · Title · Description/,
    }),
  ).toBeTruthy();
  expect(await screen.findByText("In progress")).toBeTruthy();
  expect(screen.getByText("In review")).toBeTruthy();
  expect(screen.getByText(/Kept for 30 days/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  await waitFor(() => expect(onRestored).toHaveBeenCalled());
  expect(syncReview.restore).toHaveBeenCalledWith(
    { kind: "ticket", id: "guid-12", source: "local" },
    "v3",
    expect.any(String),
  );
  expect(onClose).toHaveBeenCalled();
});

test("the list starts right under the header, with no band reserved for a failure", async () => {
  open();
  await screen.findByRole("navigation", { name: "Versions" });
  const body = document.querySelector(".dialog-shell-body");
  expect(body?.children).toHaveLength(1);
  expect(body?.firstElementChild?.classList.contains("sync-history")).toBe(
    true,
  );
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
  await screen.findByRole("button", { name: /Google Drive · Description/ });
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
      expect.any(String),
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
  const failure = await screen.findByRole("alert");
  expect(failure.textContent).toContain("Couldn't load versions");
  expect(failure.textContent).not.toContain(
    "Could not load versions from Google Drive: offline",
  );
  expect(screen.queryByText("No earlier versions")).toBeNull();
});

const connected = (
  view: ReactNode,
  provider: "google_drive" | "s3" = "google_drive",
) => (
  <SyncStatusContext
    value={{
      status: syncStatus({ provider }),
      apply: () => {},
      refresh: () => Promise.reject(new Error("unused")),
      openSettings: () => {},
      openReview: () => {},
    }}
  >
    {view}
  </SyncStatusContext>
);
const history = (
  <RecordHistory
    kind="ticket"
    id="guid-12"
    subtitle="T-KQ12"
    onClose={onClose}
    onRestored={onRestored}
  />
);

test("a synced record offers older versions from Drive below its own, loaded when asked", async () => {
  // Drive names its revisions its own way; an id can repeat a local one.
  stored.drive = [
    { id: "v2", timestamp: hours(24 * 40), device: null, changed: [] },
  ];
  render(connected(history));
  const list = within(
    await screen.findByRole("navigation", { name: "Versions" }),
  );
  expect(syncReview.versions).toHaveBeenCalledTimes(1);
  fireEvent.click(
    list.getByRole("button", { name: "Older versions from Drive" }),
  );
  const older = await list.findByRole("button", { name: /Google Drive$/ });
  expect(list.getAllByRole("button", { name: /This desktop ·/ })).toHaveLength(
    1,
  );
  expect(
    list.queryByRole("button", { name: "Older versions from Drive" }),
  ).toBeNull();
  fireEvent.click(older);
  expect(older.getAttribute("aria-current")).toBe("true");
  expect(
    list
      .getByRole("button", { name: /This desktop · Description/ })
      .getAttribute("aria-current"),
  ).toBeNull();
  expect(await screen.findByText(/From Google Drive/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  await waitFor(() =>
    expect(syncReview.restore).toHaveBeenCalledWith(
      { kind: "ticket", id: "guid-12", source: "drive" },
      "v2",
      expect.any(String),
    ),
  );
});

test("older versions that Drive cannot list say why and can be asked for again", async () => {
  vi.mocked(syncReview.versions).mockImplementation(({ source }) =>
    source === "local"
      ? Promise.resolve(versions)
      : Promise.reject(new Error("Could not load versions: offline")),
  );
  render(connected(history));
  fireEvent.click(
    await screen.findByRole("button", { name: "Older versions from Drive" }),
  );
  const failure = await screen.findByRole("alert");
  expect(failure.textContent).toContain("Couldn't load older versions");
  expect(failure.textContent).not.toContain("Could not load versions: offline");
  expect(
    screen.getByRole("button", { name: "Older versions from Drive" }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: /Studio desktop/ })).toBeTruthy();
});

test("a Workspace that does not sync offers nothing from Drive", async () => {
  open();
  await screen.findByRole("navigation", { name: "Versions" });
  expect(
    screen.queryByRole("button", { name: "Older versions from Drive" }),
  ).toBeNull();
});

test("Drive versions are placed by time among this desktop's, one heading per day", async () => {
  // A Drive revision from the day of the middle local version.
  stored.drive = [
    { id: "r1", timestamp: versions[1]!.timestamp, device: null, changed: [] },
  ];
  render(connected(history));
  fireEvent.click(
    await screen.findByRole("button", { name: "Older versions from Drive" }),
  );
  await screen.findByRole("button", { name: /Google Drive$/ });
  const days = screen
    .getAllByRole("heading", { level: 3 })
    .map((heading) => heading.textContent);
  expect(days).toHaveLength(3);
  expect(new Set(days).size).toBe(3);
});

test("Restore cannot be submitted twice, and restoring the same version again is the same request", async () => {
  vi.mocked(syncReview.restore).mockRejectedValueOnce(
    new Error("the answer was lost"),
  );
  open();
  await screen.findByText("In progress");
  const restore = screen.getByRole("button", { name: "Restore" });
  fireEvent.submit(restore);
  fireEvent.submit(restore);
  await screen.findByRole("alert");
  expect(syncReview.restore).toHaveBeenCalledTimes(1);
  fireEvent.click(restore);
  await waitFor(() => expect(onRestored).toHaveBeenCalled());
  const [first, second] = vi.mocked(syncReview.restore).mock.calls;
  expect(first?.[2]).toBeTruthy();
  expect(second?.[2]).toBe(first?.[2]);
});

test("an S3 binding reads, names and restores the bucket's versions, and never says Drive", async () => {
  stored.s3 = [
    { id: "ver-9", timestamp: hours(24 * 40), device: null, changed: [] },
  ];
  render(connected(history, "s3"));
  const list = within(
    await screen.findByRole("navigation", { name: "Versions" }),
  );
  fireEvent.click(list.getByRole("button", { name: "Older versions from S3" }));
  const older = await list.findByRole("button", { name: /S3$/ });
  expect(syncReview.versions).toHaveBeenLastCalledWith({
    kind: "ticket",
    id: "guid-12",
    source: "s3",
  });
  fireEvent.click(older);
  expect(await screen.findByText(/From S3\./)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  await waitFor(() =>
    expect(syncReview.restore).toHaveBeenCalledWith(
      { kind: "ticket", id: "guid-12", source: "s3" },
      "ver-9",
      expect.any(String),
    ),
  );
  expect(document.body.textContent).not.toMatch(/drive/i);
});

test("a version kept in a storage is captioned the same way for Drive and S3, not by the bare name", async () => {
  stored.drive = [
    { id: "r1", timestamp: hours(24 * 40), device: null, changed: [] },
  ];
  stored.s3 = [
    { id: "ver-9", timestamp: hours(24 * 40), device: null, changed: [] },
  ];
  for (const [provider, caption] of [
    ["google_drive", "Kept in Google Drive"],
    ["s3", "Kept in S3"],
  ] as const) {
    render(connected(history, provider));
    fireEvent.click(
      await screen.findByRole("button", {
        name: /Older versions from (Drive|S3)/,
      }),
    );
    const row = await screen.findByRole("button", {
      name: new RegExp(`${caption}$`),
    });
    expect(row.querySelector("small")?.textContent).toBe(caption);
    cleanup();
  }
});

test("a failure reading one storage is gone when the History reads another", async () => {
  stored.local = [];
  vi.mocked(syncReview.versions).mockImplementation(({ source }) =>
    source === "drive"
      ? Promise.reject(new Error("offline"))
      : Promise.resolve(source === "s3" ? [versions[1]!] : []),
  );
  const { rerender } = render(connected(history, "google_drive"));
  expect(await screen.findByRole("alert")).toBeTruthy();
  // The status turned out to say S3: the first source's failure is not this one's.
  rerender(connected(history, "s3"));
  await screen.findByRole("button", { name: /S3 · Description/ });
  expect(screen.queryByRole("alert")).toBeNull();
});

test("an S3 listing that finds no older versions says so in S3's name", async () => {
  render(connected(history, "s3"));
  fireEvent.click(
    await screen.findByRole("button", { name: "Older versions from S3" }),
  );
  expect(await screen.findByText("No older versions in S3")).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/drive/i);
});

test("a desktop without local versions loads them from S3 and says so", async () => {
  stored.local = [];
  stored.s3 = [versions[1]!];
  render(connected(history, "s3"));
  await screen.findByRole("button", { name: /S3 · Description/ });
  expect(screen.getByText(/From S3\./)).toBeTruthy();
  expect(syncReview.versions).toHaveBeenCalledWith({
    kind: "ticket",
    id: "guid-12",
    source: "s3",
  });
  expect(document.body.textContent).not.toMatch(/drive/i);
});

test("when older versions load, focus moves to the first one that loaded", async () => {
  stored.drive = [
    { id: "r1", timestamp: hours(24 * 40), device: null, changed: [] },
    { id: "r2", timestamp: hours(24 * 41), device: null, changed: [] },
  ];
  render(connected(history));
  const ask = await screen.findByRole("button", {
    name: "Older versions from Drive",
  });
  ask.focus();
  fireEvent.click(ask);
  const loaded = await screen.findAllByRole("button", {
    name: /Google Drive$/,
  });
  await waitFor(() => expect(document.activeElement).toBe(loaded[0]));
});

test("when the storage has no older versions, focus moves to the list", async () => {
  stored.drive = [];
  render(connected(history));
  const ask = await screen.findByRole("button", {
    name: "Older versions from Drive",
  });
  ask.focus();
  fireEvent.click(ask);
  await screen.findByText("No older versions in Google Drive");
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("navigation", { name: "Versions" }),
    ),
  );
});
