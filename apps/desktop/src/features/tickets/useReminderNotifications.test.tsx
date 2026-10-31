// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { setPreference } from "@/lib/preferences";
import { notificationClient } from "@/lib/api/notifications";
import { useReminderNotifications } from "./useReminderNotifications";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
vi.mock("@/lib/api/notifications", () => ({
  notificationClient: {
    permitted: vi.fn(),
    requestPermission: vi.fn(),
    notify: vi.fn(),
  },
}));

const entry = (id: number, kind: string) => ({
  id,
  reference: `T-${id}`,
  title: `Ticket ${id}`,
  kind,
  from_value: "",
  to_value: "",
  timestamp: "2026-01-01T00:00:00Z",
  read: false,
  editing_agent: null,
});

let inbox: ReturnType<typeof entry>[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  inbox = [entry(5, "reminder")];
  bridge.invoke.mockImplementation(async () => inbox);
  vi.mocked(notificationClient.permitted).mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  localStorage.clear();
});

async function tick() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
}

test("a reminder that becomes due while open notifies once; earlier ones stay in the inbox", async () => {
  setPreference("notifyReminders", true);
  const open = vi.fn();
  renderHook(() => useReminderNotifications(open));
  await act(async () => {});
  expect(notificationClient.notify).not.toHaveBeenCalled();

  inbox = [entry(7, "reminder"), entry(6, "status"), entry(5, "reminder")];
  await tick();
  await tick();
  expect(notificationClient.notify).toHaveBeenCalledTimes(1);
  expect(notificationClient.notify).toHaveBeenCalledWith(
    "Ticket 7",
    "T-7: reminder is due",
  );

  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(open).toHaveBeenCalledWith("T-7");
});

test("nothing is shown while the preference is off", async () => {
  const open = vi.fn();
  renderHook(() => useReminderNotifications(open));
  inbox = [entry(9, "reminder")];
  await tick();
  await tick();
  expect(bridge.invoke).not.toHaveBeenCalled();
  expect(notificationClient.notify).not.toHaveBeenCalled();
});
