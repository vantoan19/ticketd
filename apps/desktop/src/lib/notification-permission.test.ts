// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  notificationClient,
  type NotificationPermission,
} from "@/lib/api/notifications";
import {
  askForNotifications,
  notificationsAllowed,
  resetNotificationPermission,
} from "@/lib/notification-permission";

vi.mock("@/lib/api/notifications", () => ({
  notificationClient: { permission: vi.fn(), ask: vi.fn() },
}));

const permission = (
  state: NotificationPermission["state"],
): NotificationPermission => ({ state, reported: true, settings: true });

beforeEach(() => {
  resetNotificationPermission();
});
afterEach(() => {
  vi.clearAllMocks();
});

test("the system is asked while it has not been asked", async () => {
  vi.mocked(notificationClient.permission).mockResolvedValue(
    permission("not_asked"),
  );
  vi.mocked(notificationClient.ask).mockResolvedValue(permission("allowed"));
  expect((await askForNotifications())?.state).toBe("allowed");
  expect(notificationClient.ask).toHaveBeenCalledTimes(1);
});

test.each(["allowed", "blocked"] as const)(
  "a %s system is never asked again",
  async (state) => {
    vi.mocked(notificationClient.permission).mockResolvedValue(
      permission(state),
    );
    expect((await askForNotifications())?.state).toBe(state);
    expect(notificationClient.ask).not.toHaveBeenCalled();
  },
);

test("a system that cannot be read is not asked and counts as not allowed", async () => {
  vi.mocked(notificationClient.permission).mockRejectedValue(new Error("no"));
  expect(await askForNotifications()).toBeNull();
  expect(notificationClient.ask).not.toHaveBeenCalled();
  expect(await notificationsAllowed()).toBe(false);
});

test("only an allowed system lets a notification out", async () => {
  vi.mocked(notificationClient.permission).mockResolvedValue(
    permission("blocked"),
  );
  expect(await notificationsAllowed()).toBe(false);
  vi.mocked(notificationClient.permission).mockResolvedValue(
    permission("allowed"),
  );
  expect(await notificationsAllowed()).toBe(true);
});
