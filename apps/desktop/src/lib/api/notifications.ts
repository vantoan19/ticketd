import {
  isPermissionGranted,
  onAction,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

export const notificationClient = {
  /** True when the operating system lets ticketd show notifications. */
  async permitted() {
    return isPermissionGranted();
  },
  /** Asks the operating system once if needed; resolves to whether it is allowed. */
  async requestPermission() {
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === "granted";
  },
  /** `reference` comes back with the click, so it can open the ticket. */
  notify(title: string, body: string, reference: string) {
    sendNotification({ title, body, extra: { reference } });
  },
  /**
   * Calls `open` with the ticket reference when the person clicks a
   * notification. Register before notifying: the plugin reports clicks only
   * for notifications shown while a listener exists. Resolves to a function
   * that stops listening.
   */
  async onClick(open: (reference: string) => void): Promise<() => void> {
    const listener = await onAction((event) => {
      if (event.actionId !== "tap") return;
      const reference = event.notification?.extra?.reference;
      if (typeof reference === "string") open(reference);
    });
    return () => void listener.unregister().catch(() => {});
  },
};
