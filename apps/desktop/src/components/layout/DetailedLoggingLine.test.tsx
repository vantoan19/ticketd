// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SourceStatusFooter } from "@/components/layout/SourceStatusFooter";
import { setDetailedLogging } from "@/features/settings/detailed-logging";
import { SettingsNavigation } from "@/lib/settings-navigation";

window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

/** The level the app answers with: a report started `startedAt` ago, or none. */
function appLevel(startedAt: string | null) {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "diagnostics_log_level") {
      return {
        level: startedAt ? "debug" : "info",
        debug: startedAt !== null,
        env_override: null,
        report_started_at: startedAt,
      };
    }
    return [];
  });
}

beforeEach(() => setDetailedLogging(null));
afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
});

test("a report left open by the last run puts a line in the sidebar's footer", async () => {
  appLevel(minutesAgo(2));
  const open = vi.fn();
  render(
    <SettingsNavigation.Provider value={open}>
      <SourceStatusFooter />
    </SettingsNavigation.Provider>,
  );
  const line = await screen.findByRole("button", {
    name: /Detailed logging is on/,
  });
  expect(line.textContent).toContain("Started 2 min ago");

  fireEvent.click(line);
  expect(open).toHaveBeenLastCalledWith("diagnostics");
  fireEvent.click(screen.getByRole("button", { name: "Save report" }));
  expect(open).toHaveBeenCalledTimes(2);
  expect(open).toHaveBeenLastCalledWith("diagnostics");
});

test("with no report open the footer shows nothing", async () => {
  appLevel(null);
  const { container } = render(<SourceStatusFooter />);
  await vi.waitFor(() =>
    expect(bridge.invoke).toHaveBeenCalledWith("diagnostics_log_level"),
  );
  expect(container.textContent).toBe("");
});

test("the line follows a report as it starts and ends", async () => {
  appLevel(null);
  const { container } = render(<SourceStatusFooter />);
  expect(container.textContent).toBe("");
  setDetailedLogging(minutesAgo(1));
  await screen.findByText("Detailed logging is on");
  setDetailedLogging(null);
  await vi.waitFor(() => expect(container.textContent).toBe(""));
});
