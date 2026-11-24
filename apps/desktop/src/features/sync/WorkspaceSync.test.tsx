// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { s3Api } from "@/lib/s3-api";
import { syncApi } from "@/lib/sync-api";
import { TestReads } from "@/lib/workspace-reads/testing";
import { SyncStatusProvider } from "./SyncStatusProvider";
import { WorkspaceSync } from "./WorkspaceSync";
import { notConnected, syncSettings, syncStatus } from "./sync-fixtures";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/s3-api", async (original) => ({
  ...(await original<typeof import("@/lib/s3-api")>()),
  s3Api: {
    profiles: vi.fn(),
    identity: vi.fn(),
    signIn: vi.fn(),
    buckets: vi.fn(),
  },
}));
vi.mock("@/lib/sync-api", async (original) => ({
  ...(await original<typeof import("@/lib/sync-api")>()),
  syncApi: {
    status: vi.fn(),
    connect: vi.fn(),
    settings: vi.fn(),
    disconnect: vi.fn(),
    setupOptions: vi.fn(),
  },
}));
const sync = vi.mocked(syncApi);

beforeEach(() => {
  vi.mocked(s3Api.profiles).mockResolvedValue({
    cli: { state: "ready" },
    profiles: ["work", "personal"],
  });
  sync.settings.mockResolvedValue(syncSettings());
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function show() {
  return render(
    <TestReads>
      <SyncStatusProvider>
        <WorkspaceSync onReplaced={async () => {}} />
      </SyncStatusProvider>
    </TestReads>,
  );
}

test("before any storage is connected, Google Drive is chosen and its flow is as it was", async () => {
  sync.status.mockResolvedValue(notConnected());
  show();
  const storage = await screen.findByRole("radiogroup", { name: "Storage" });
  expect(
    within(storage)
      .getByRole("radio", { name: /Google Drive/ })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    await screen.findByRole("button", { name: "Connect Google Drive" }),
  ).toBeTruthy();
  expect(screen.queryByLabelText("AWS profile")).toBeNull();
  expect(s3Api.profiles).not.toHaveBeenCalled();
});

test("choosing S3 swaps Google Drive's connect card for the S3 steps, and back", async () => {
  sync.status.mockResolvedValue(notConnected());
  show();
  const storage = await screen.findByRole("radiogroup", { name: "Storage" });
  fireEvent.click(within(storage).getByRole("radio", { name: /S3/ }));
  expect(await screen.findByText("AWS profile")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Connect Google Drive" }),
  ).toBeNull();

  fireEvent.click(within(storage).getByRole("radio", { name: /Google Drive/ }));
  expect(
    await screen.findByRole("button", { name: "Connect Google Drive" }),
  ).toBeTruthy();
});

test("a connected Google Drive Workspace shows no storage choice", async () => {
  sync.status.mockResolvedValue(syncStatus());
  show();
  expect(await screen.findByText("Connected as you@example.com")).toBeTruthy();
  expect(screen.queryByRole("radiogroup", { name: "Storage" })).toBeNull();
});

test("an S3 connection goes on to choosing a Workspace, with no storage choice", async () => {
  sync.setupOptions.mockResolvedValue({
    local: { tickets: 3, documents: 1, attachments: 0 },
    existing: [],
    reconnect: null,
  });
  sync.status.mockResolvedValue(
    syncStatus({
      connection: "choosing",
      provider: "s3",
      account: "arn:aws:sts::1:assumed-role/Admin/mina",
      folder: null,
      s3: {
        bucket: "team-ticketd",
        prefix: "ticketd/",
        profile: "work",
        aws_cli_path: null,
      },
    }),
  );
  show();
  expect(
    await screen.findByRole("radio", { name: /Upload this Workspace/ }),
  ).toBeTruthy();
  expect(screen.queryByRole("radiogroup", { name: "Storage" })).toBeNull();
});
