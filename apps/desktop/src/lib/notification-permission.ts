import { useEffect, useSyncExternalStore } from "react";
import {
  notificationClient,
  type NotificationPermission,
} from "@/lib/api/notifications";

/**
 * The one place the app learns whether it may notify, and the one place it asks.
 * The system keeps the answer, so "asked once" needs no copy of ours: it asks
 * only while the system says it has not been asked. The state is read again
 * when the window regains focus, because only System Settings can change a
 * block.
 */
let current: NotificationPermission | null = null;
const listeners = new Set<() => void>();
let reading: Promise<NotificationPermission | null> | null = null;

function publish(next: NotificationPermission | null) {
  if (
    next &&
    current &&
    next.state === current.state &&
    next.settings === current.settings &&
    next.reported === current.reported
  )
    return;
  current = next;
  for (const listener of listeners) listener();
}

/** Reads the permission from the system. `null` when it cannot be read. */
export function refreshNotificationPermission(): Promise<NotificationPermission | null> {
  reading ??= notificationClient
    .permission()
    .then(
      (permission) => {
        publish(permission);
        return permission;
      },
      () => null,
    )
    .finally(() => {
      reading = null;
    });
  return reading;
}

/**
 * Asks the system for permission from the one place a person understands why:
 * their first reminder, their first Chat message, or the button on Attention.
 * Does nothing once the system has an answer.
 */
export async function askForNotifications(): Promise<NotificationPermission | null> {
  try {
    const before = await refreshNotificationPermission();
    if (before?.state !== "not_asked") return before;
    return await requestNotificationPermission();
  } catch {
    return refreshNotificationPermission();
  }
}

/**
 * Shows the system's prompt and publishes its answer, so the app knows it
 * without a second read that could fail. Throws when the request itself fails.
 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  const after = await notificationClient.ask();
  publish(after);
  return after;
}

/** True when the system lets ticketd show a notification now. */
export async function notificationsAllowed(): Promise<boolean> {
  return (await refreshNotificationPermission())?.state === "allowed";
}

function onFocus() {
  void refreshNotificationPermission();
}
function onVisible() {
  if (document.visibilityState === "visible") onFocus();
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    }
  };
}

/** The permission, `null` until the first read; read again on every focus. */
export function useNotificationPermission(): NotificationPermission | null {
  const permission = useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
  useEffect(() => {
    void refreshNotificationPermission();
  }, []);
  return permission;
}

/** For tests: forgets what was read. */
export function resetNotificationPermission() {
  current = null;
  reading = null;
}
