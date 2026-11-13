// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { NotificationsCard } from "@/features/chats/NotificationsCard";
import { loadPreferences } from "@/lib/preferences";

const permission = vi.hoisted(() => ({ allowed: false }));
vi.mock("@/lib/api/notifications", () => ({
  notificationClient: {
    permitted: async () => permission.allowed,
    requestPermission: async () => permission.allowed,
  },
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const notify = () =>
  screen.getByRole("switch", { name: "Notify me about Chats" });

test("blocked notifications read as off until Check again finds them allowed", async () => {
  permission.allowed = false;
  render(<NotificationsCard />);
  expect(await screen.findByText("Notifications are blocked")).toBeTruthy();
  expect(notify().getAttribute("aria-checked")).toBe("false");
  // The person's choice is kept while the system blocks it.
  expect(loadPreferences().notifyChats).toBe(true);

  permission.allowed = true;
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  expect(
    await screen.findByRole("switch", {
      name: "Notify me about Chats",
      checked: true,
    }),
  ).toBeTruthy();
  expect(screen.queryByText("Notifications are blocked")).toBeNull();

  fireEvent.click(notify());
  expect(loadPreferences().notifyChats).toBe(false);
});
