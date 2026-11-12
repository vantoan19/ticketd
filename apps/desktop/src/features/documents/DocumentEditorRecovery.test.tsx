// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { DocumentEditor } from "./DocumentEditor";
import { documents } from "./api";
import { TickingChanges } from "@/test/ticking-changes";
import { invoke } from "@tauri-apps/api/core";
import { DraftRecoveryProvider } from "@/lib/draft-recovery";

vi.mock("@/lib/sync-review-api", () => ({
  syncReview: {
    conflicts: vi.fn(async () => []),
    versions: vi.fn(async () => []),
    version: vi.fn(),
    restore: vi.fn(),
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const renderEditor = (ui: ReactElement) =>
  render(
    <DraftRecoveryProvider>
      <TickingChanges>{ui}</TickingChanges>
    </DraftRecoveryProvider>,
  );
vi.mock("./api", () => ({
  documents: {
    save: vi.fn(),
    show: vi.fn(),
    version: vi.fn(),
    setTrashed: vi.fn(),
    links: vi.fn().mockResolvedValue([[], []]),
    createTicket: vi.fn(),
    linkMarkdown: vi.fn(),
    recent: vi.fn(),
    search: vi.fn(),
  },
}));
vi.mock("@/features/markdown/LazyMarkdownEditor", () => ({
  LazyMarkdownEditor: ({
    value,
    onChange,
    focusRequest = 0,
  }: {
    value: string;
    onChange: (value: string) => void;
    focusRequest?: number;
  }) => (
    <textarea
      aria-label="Your thought"
      data-focus-request={focusRequest}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it("Retry saves as soon as write access returns, without Retry draft recovery", async () => {
  let writable = false;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "draft_retentions") return [];
    if (command === "draft_cutover_pending") return false;
    if (command === "retain_draft") {
      if (!writable) throw new Error("attempt to write a readonly database");
      const draft = (args as { draft: { revision: number } }).draft;
      return { ...draft, revision: draft.revision + 1 };
    }
    return [];
  });
  vi.mocked(documents.links).mockResolvedValue([[], []]);
  vi.mocked(documents.save).mockResolvedValue({
    id: "d1",
    title: null,
    body: "A thought",
    created_at: "now",
    updated_at: "now",
    trashed: false,
  });
  renderEditor(<DocumentEditor initial={null} onClose={vi.fn()} />);
  fireEvent.change(await screen.findByLabelText("Your thought"), {
    target: { value: "A thought" },
  });
  fireEvent.click(screen.getByText("Done"));
  await screen.findAllByText(/readonly database/);
  expect(documents.save).not.toHaveBeenCalled();
  writable = true;
  fireEvent.click(screen.getByText("Retry"));
  await waitFor(() => expect(documents.save).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(screen.queryAllByText(/readonly database/)).toHaveLength(0),
  );
});
