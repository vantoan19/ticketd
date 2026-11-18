// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { setPreference } from "@/lib/preferences";
import { notificationClient } from "@/lib/api/notifications";
import { WorkspaceChangeProvider } from "@/lib/workspace-change";
import { useReminderNotifications } from "./useReminderNotifications";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
vi.mock("@/lib/api/notifications", () => ({
  notificationClient: {
    permitted: vi.fn(),
    requestPermission: vi.fn(),
    notify: vi.fn(),
    onClick: vi.fn(),
  },
}));

const entry = (id: number, kind: string) => ({
  id,
  reference: `T-KQ${id}`,
  title: `Ticket ${id}`,
  kind,
  from_value: "",
  to_value: "",
  timestamp: "2026-01-01T00:00:00Z",
  read: false,
  editing_agent: null,
});

let inbox: ReturnType<typeof entry>[] = [];
let click: ((reference: string) => void) | null = null;
const stopListening = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  inbox = [entry(5, "reminder")];
  bridge.invoke.mockImplementation(async () => inbox);
  vi.mocked(notificationClient.permitted).mockResolvedValue(true);
  click = null;
  vi.mocked(notificationClient.onClick).mockImplementation(async (open) => {
    click = open;
    return stopListening;
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  localStorage.clear();
});

// Reminders reach the inbox when the desktop delivers them, which moves the
// change token: the hook reads the inbox on each workspace change, never on a timer.
let version = 0;
const changes = ({ children }: { children: ReactNode }) => (
  <WorkspaceChangeProvider value={version}>{children}</WorkspaceChangeProvider>
);
let rerender = () => {};
function render(hook: () => void) {
  const view = renderHook(hook, { wrapper: changes });
  rerender = () => view.rerender();
  return view;
}

async function tick() {
  version += 1;
  await act(async () => {
    rerender();
    await vi.advanceTimersByTimeAsync(0);
  });
}

test("a reminder that becomes due while open notifies once; earlier ones stay in the inbox", async () => {
  setPreference("notifyReminders", true);
  const open = vi.fn();
  render(() => useReminderNotifications(open));
  await act(async () => {});
  expect(notificationClient.notify).not.toHaveBeenCalled();

  inbox = [entry(7, "reminder"), entry(6, "status"), entry(5, "reminder")];
  await tick();
  await tick();
  expect(notificationClient.notify).toHaveBeenCalledTimes(1);
  expect(notificationClient.notify).toHaveBeenCalledWith(
    "Ticket 7",
    "T-KQ7: reminder is due",
    "T-KQ7",
  );
});

test("clicking a notification opens its ticket, and regaining focus does not", async () => {
  setPreference("notifyReminders", true);
  const open = vi.fn();
  render(() => useReminderNotifications(open));
  await act(async () => {});
  inbox = [entry(7, "reminder"), entry(5, "reminder")];
  await tick();
  await tick();
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(open).not.toHaveBeenCalled();
  // A click that comes long after the reminder still opens the ticket.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10 * 60_000);
  });
  act(() => click?.("T-KQ7"));
  expect(open).toHaveBeenCalledWith("T-KQ7");
});

test("the click listener exists before any notification and stops with the preference", async () => {
  setPreference("notifyReminders", true);
  const view = render(() => useReminderNotifications(() => {}));
  await act(async () => {});
  expect(notificationClient.onClick).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(stopListening).toHaveBeenCalledTimes(1);
});

test("reminders still notify after a restore replaced the inbox with lower ids", async () => {
  setPreference("notifyReminders", true);
  inbox = [entry(40, "reminder")];
  render(() => useReminderNotifications(() => {}));
  await act(async () => {});
  inbox = [entry(12, "status")];
  await tick();
  inbox = [entry(13, "reminder"), entry(12, "status")];
  await tick();
  expect(notificationClient.notify).toHaveBeenCalledTimes(1);
  expect(notificationClient.notify).toHaveBeenCalledWith(
    "Ticket 13",
    "T-KQ13: reminder is due",
    "T-KQ13",
  );
});

test("no change, no inbox read: the hook does not poll", async () => {
  setPreference("notifyReminders", true);
  render(() => useReminderNotifications(() => {}));
  await act(async () => {});
  bridge.invoke.mockClear();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(bridge.invoke).not.toHaveBeenCalled();
});

test("nothing is shown while the preference is off", async () => {
  const open = vi.fn();
  render(() => useReminderNotifications(open));
  inbox = [entry(9, "reminder")];
  await tick();
  await tick();
  expect(bridge.invoke).not.toHaveBeenCalled();
  expect(notificationClient.notify).not.toHaveBeenCalled();
});
