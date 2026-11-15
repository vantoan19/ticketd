// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DocumentEditor } from "@/features/documents/DocumentEditor";
import { syncApi, type SyncStatus } from "@/lib/sync-api";
import { SyncStatusProvider } from "./SyncStatusProvider";
import { notConnected, syncStatus } from "./sync-fixtures";

vi.mock("@/lib/sync-api", async (original) => ({
  ...(await original<typeof import("@/lib/sync-api")>()),
  syncApi: { status: vi.fn() },
}));
vi.mock("@/features/documents/api", () => ({
  documents: {
    show: vi.fn(),
    version: vi.fn(),
    links: vi.fn().mockResolvedValue([[], []]),
  },
}));
vi.mock("@/features/markdown/LazyMarkdownEditor", () => ({
  LazyMarkdownEditor: () => <textarea aria-label="Your thought" />,
}));

afterEach(cleanup);

const spec = {
  id: "d1",
  title: "Login hardening spec",
  body: "Lock out after five attempts.",
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
  trashed: false,
};
async function bar(status: SyncStatus) {
  vi.mocked(syncApi.status).mockResolvedValue(status);
  render(
    <SyncStatusProvider>
      <DocumentEditor initial={spec} onClose={() => {}} />
    </SyncStatusProvider>,
  );
  await waitFor(() => expect(syncApi.status).toHaveBeenCalled());
  // The save state shows while editing, in the session row (plans DR-09).
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  return screen.findByRole("status");
}

test("a Document without sync is saved on this computer", async () => {
  expect((await bar(notConnected())).textContent).toBe(
    "Saved on this computer",
  );
});

test("an uploaded Document's bar says Synced to Drive", async () => {
  await bar(syncStatus());
  expect(
    (await screen.findByText("Synced to Drive")).getAttribute("role"),
  ).toBe("status");
});

test("a Document whose change still waits stays Saved on this computer", async () => {
  const waiting = await bar(
    syncStatus({
      state: "upload_pending",
      pending_uploads: [
        { kind: "document", id: "d1", reference: null, title: spec.title },
      ],
    }),
  );
  expect(waiting.textContent).toBe("Saved on this computer");
  expect(screen.queryByText("Synced to Drive")).toBeNull();
});

test("a Document changed on two desktops says Needs review", async () => {
  await bar(
    syncStatus({
      state: "needs_attention",
      needs_review: [
        { kind: "document", id: "d1", reference: null, title: spec.title },
      ],
    }),
  );
  expect(await screen.findByText("Needs review")).toBeTruthy();
});

test("a Document that may be among changes not listed is not called synced", async () => {
  const waiting = await bar(
    syncStatus({
      state: "upload_pending",
      pending_uploads: [
        { kind: "ticket", id: "t1", reference: "T-KQ1", title: "Other" },
      ],
      pending_total: 2,
    }),
  );
  expect(waiting.textContent).toBe("Saved on this computer");
  expect(screen.queryByText("Synced to Drive")).toBeNull();
});
