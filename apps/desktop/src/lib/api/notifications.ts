import { invoke } from "@/lib/api/bridge-failure";
import { lazySchema } from "@/lib/api/lazy-schema";
import { onAction, sendNotification } from "@tauri-apps/plugin-notification";
import { z } from "zod";

const permissionSchema = lazySchema(() =>
  z.object({
    state: z.enum(["allowed", "not_asked", "blocked"]),
    /** False where the system cannot say; the state is then a plain "allowed". */
    reported: z.boolean(),
    /** Whether the system has notification settings to open. */
    settings: z.boolean(),
  }),
);

export type NotificationPermission = z.infer<typeof permissionSchema>;
export type NotificationPermissionState = NotificationPermission["state"];

export const notificationClient = {
  /**
   * What the operating system says about ticketd's notifications. The
   * notification plugin answers "granted" on every desktop, so the desktop
   * reads the system itself.
   */
  async permission(): Promise<NotificationPermission> {
    return permissionSchema.parse(await invoke("notification_permission"));
  },
  /**
   * Shows the system's prompt, which only happens while the person has not
   * been asked. Resolves to the permission afterwards.
   */
  async ask(): Promise<NotificationPermission> {
    return permissionSchema.parse(
      await invoke("request_notification_permission"),
    );
  },
  /** Opens the system's notification settings. */
  async openSettings(): Promise<void> {
    await invoke("open_notification_settings");
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
