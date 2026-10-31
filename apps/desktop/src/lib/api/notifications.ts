import {
  isPermissionGranted,
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
  notify(title: string, body: string) {
    sendNotification({ title, body });
  },
};
