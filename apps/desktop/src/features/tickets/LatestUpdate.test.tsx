// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { LatestUpdate } from "./LatestUpdate";
import { OpenTicketFor } from "./open-ticket/parts/activity-testing";

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
  render(
    <OpenTicketFor reference="T-KQ1">
      <LatestUpdate active onOpen={open} />
    </OpenTicketFor>,
  );
  await screen.findByText("Review complete: details");
  expect(screen.getByText(/Agent/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^Go to update/ }));
  expect(open).toHaveBeenCalledWith("a-1");
});

test("distinguishes an absent update from a failed read and allows retry", async () => {
  bridge.invoke
    .mockRejectedValueOnce(new Error("Database unavailable"))
    .mockResolvedValueOnce(null);
  render(
    <OpenTicketFor reference="T-KQ1">
      <LatestUpdate active />
    </OpenTicketFor>,
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Couldn't load the latest update",
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("No update reported");
});

test("a hidden page reads nothing until it is shown", async () => {
  bridge.invoke.mockResolvedValue(null);
  const view = render(
    <OpenTicketFor reference="T-KQ1" hidden>
      <LatestUpdate active />
    </OpenTicketFor>,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(bridge.invoke).not.toHaveBeenCalled();
  view.rerender(
    <OpenTicketFor reference="T-KQ1">
      <LatestUpdate active />
    </OpenTicketFor>,
  );
  await screen.findByText("No update reported");
  expect(bridge.invoke).toHaveBeenCalledTimes(1);
});
