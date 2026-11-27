// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { revealFailureDetails } from "@/test/failure-details";
import { workspaceClient } from "@/lib/api/workspace";
import { findSetting } from "@/features/settings/settings-highlight";
import { SupportCards } from "@/features/settings/pages/SupportCards";

vi.mock("@/lib/api/workspace", () => ({
  workspaceClient: { openLink: vi.fn() },
}));

beforeEach(() => {
  vi.mocked(workspaceClient.openLink).mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const COFFEE = "https://buymeacoffee.com/example";

test("with a Buy me a coffee page, both cards open their links in the browser", async () => {
  render(<SupportCards coffeeUrl={COFFEE} />);
  expect(screen.getByRole("heading", { name: "Support ticketd" })).toBeTruthy();
  expect(screen.getByText("Helps other people find ticketd.")).toBeTruthy();
  expect(
    screen.getByText("Helps one maintainer keep ticketd going."),
  ).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Star on GitHub" }));
  await waitFor(() =>
    expect(workspaceClient.openLink).toHaveBeenLastCalledWith(
      "https://github.com/vantoan19/ticketd",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Buy me a coffee" }));
  await waitFor(() =>
    expect(workspaceClient.openLink).toHaveBeenLastCalledWith(COFFEE),
  );
  expect(workspaceClient.openLink).toHaveBeenCalledTimes(2);
});

test("without a Buy me a coffee page, only Star on GitHub shows", () => {
  render(<SupportCards coffeeUrl={null} />);
  expect(screen.getByRole("button", { name: "Star on GitHub" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /coffee/i })).toBeNull();
  expect(screen.queryByText(/maintainer/)).toBeNull();
});

test("a link that cannot open says so", async () => {
  vi.mocked(workspaceClient.openLink).mockRejectedValue("no browser");
  render(<SupportCards coffeeUrl={null} />);
  fireEvent.click(screen.getByRole("button", { name: "Star on GitHub" }));
  await revealFailureDetails();
  expect(screen.getByRole("alert").textContent).toContain("no browser");
});

test("Search shows the whole card, not just its button", () => {
  const { container } = render(<SupportCards coffeeUrl={COFFEE} />);
  expect(
    findSetting(container, "Star on GitHub")?.getAttribute("data-kind"),
  ).toBe("star");
  expect(
    findSetting(container, "Buy me a coffee")?.getAttribute("data-kind"),
  ).toBe("coffee");
});
