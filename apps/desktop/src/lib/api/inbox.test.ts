// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from "vitest";
import { inboxClient } from "@/lib/api/inbox";
import { notificationClient } from "@/lib/api/notifications";
import { resetNotificationPermission } from "@/lib/notification-permission";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
vi.mock("@/lib/api/notifications", () => ({
  notificationClient: { permission: vi.fn(), ask: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetNotificationPermission();
  bridge.invoke.mockResolvedValue(null);
  vi.mocked(notificationClient.permission).mockResolvedValue({
    state: "not_asked",
    reported: true,
    settings: true,
  });
  vi.mocked(notificationClient.ask).mockResolvedValue({
    state: "allowed",
    reported: true,
    settings: true,
  });
});

test("setting a reminder is the moment ticketd asks to notify", async () => {
  await inboxClient.snooze("T-1", "2026-12-01T09:00:00Z");
  await vi.waitFor(() =>
    expect(notificationClient.ask).toHaveBeenCalledTimes(1),
  );
});

test("clearing a reminder asks nothing", async () => {
  await inboxClient.snooze("T-1", null);
  await Promise.resolve();
  expect(notificationClient.permission).not.toHaveBeenCalled();
  expect(notificationClient.ask).not.toHaveBeenCalled();
});
