// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { OpenEvidence } from "./evidence-test-support";

afterEach(cleanup);

const opener = vi.hoisted(() => ({ openUrl: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: opener.openUrl,
  revealItemInDir: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => {
  const item = (id: string, kind: string, name: string, value: string) => ({
    id,
    kind,
    name,
    value,
    editing_agent: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  });
  return {
    invoke: vi.fn(async (command: string) =>
      command === "ticket_evidence_page"
        ? {
            total: 2,
            items: [
              item("1", "pull_request", "PR", "https://example.com/pr/1"),
              item("2", "branch", "Branch", "feature/x"),
            ],
          }
        : undefined,
    ),
  };
});

test("a URL evidence item can be opened; other values cannot", async () => {
  render(<OpenEvidence reference="T-KQ1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Open PR" }));
  expect(opener.openUrl).toHaveBeenCalledWith("https://example.com/pr/1");
  expect(screen.queryByRole("button", { name: "Open Branch" })).toBeNull();
});
