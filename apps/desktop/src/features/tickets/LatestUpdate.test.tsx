// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { LatestUpdate } from "./LatestUpdate";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
});

test("shows the reported brief and opens its exact Activity", async () => {
  bridge.invoke.mockResolvedValue({
    activity_id: "a-1",
    brief: {
      text: "**Review complete:** [details](https://example.com)",
      truncated: false,
    },
    reported_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    editing_agent: "Agent",
    supporting_document_id: null,
  });
  const open = vi.fn();
  render(<LatestUpdate reference="T-1" active revision={0} onOpen={open} />);
  await screen.findByText("Review complete: details");
  expect(screen.getByText(/Agent/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Go to update" }));
  expect(open).toHaveBeenCalledWith("a-1");
});

test("distinguishes an absent update from a failed read and allows retry", async () => {
  bridge.invoke
    .mockRejectedValueOnce(new Error("Database unavailable"))
    .mockResolvedValueOnce(null);
  render(<LatestUpdate reference="T-1" active revision={0} />);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Database unavailable",
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("No update reported");
});

test("refreshes the preview when the workspace revision changes", async () => {
  const report = {
    activity_id: "a-1",
    brief: { text: "First report", truncated: false },
    reported_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    editing_agent: null,
    supporting_document_id: null,
  };
  bridge.invoke.mockResolvedValueOnce(report).mockResolvedValueOnce({
    ...report,
    brief: { text: "Corrected report", truncated: true },
  });
  const view = render(<LatestUpdate reference="T-1" active revision={0} />);
  await screen.findByText("First report");
  view.rerender(<LatestUpdate reference="T-1" active revision={1} />);
  await screen.findByText("Corrected report…");
});
