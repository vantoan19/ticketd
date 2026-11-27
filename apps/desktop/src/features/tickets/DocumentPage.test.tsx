// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { WorkspaceChangeProvider } from "@/lib/workspace-change";
import { DocumentPage } from "./DocumentPage";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function serve(body: () => string) {
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "show_document"
      ? {
          id: "d1",
          title: "Plan",
          body: body(),
          created_at: "2026-11-27T00:00:00Z",
          updated_at: "2026-11-27T00:00:00Z",
          trashed: false,
        }
      : null,
  );
}
const page = (version: number) => (
  <WorkspaceChangeProvider value={version}>
    <DocumentPage id="d1" title="Plan" wanted />
  </WorkspaceChangeProvider>
);

test("the first page follows an edit of the Document when the Workspace changes", async () => {
  let body = "# Plan\n\nFirst draft of the plan.";
  serve(() => body);
  const view = render(page(1));
  expect(await screen.findByText("First draft of the plan.")).toBeTruthy();
  body = "# Plan\n\nSecond draft, rewritten.";
  view.rerender(page(2));
  expect(await screen.findByText("Second draft, rewritten.")).toBeTruthy();
  expect(screen.queryByText("First draft of the plan.")).toBeNull();
});

test("a change that leaves the first page as it was does not repaint it", async () => {
  serve(() => "# Plan\n\nSame words.");
  const view = render(page(1));
  const first = await screen.findByText("Same words.");
  view.rerender(page(2));
  await waitFor(() =>
    expect(
      vi.mocked(invoke).mock.calls.filter(([name]) => name === "show_document"),
    ).toHaveLength(2),
  );
  expect(screen.getByText("Same words.")).toBe(first);
});
