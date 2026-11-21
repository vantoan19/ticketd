import { listen } from "@tauri-apps/api/event";
import { z } from "zod";
import { invoke } from "@/lib/api/bridge-failure";
import { lazySchema } from "@/lib/api/lazy-schema";

const updateInfo = lazySchema(() =>
  z.object({
    version: z.string(),
    release_url: z.url(),
    upgrades_workspace: z.boolean(),
  }),
);

const snapshot = lazySchema(() =>
  z.intersection(
    z.object({
      revision: z.number().int().nonnegative(),
      automatic: z.boolean(),
      dismissed: z.boolean(),
    }),
    z.discriminatedUnion("status", [
      z.object({ status: z.literal("idle") }),
      z.object({ status: z.literal("checking") }),
      z.object({ status: z.literal("up_to_date"), checked_at: z.number() }),
      z.object({ status: z.literal("check_failed") }),
      z.object({ status: z.literal("downloading"), update: updateInfo }),
      z.object({
        status: z.literal("download_failed"),
        update: updateInfo,
        error: z.string(),
        verification_failed: z.boolean(),
      }),
      z.object({ status: z.literal("manual_install"), update: updateInfo }),
      z.object({ status: z.literal("ready"), update: updateInfo }),
    ]),
  ),
);

const runningWork = lazySchema(() =>
  z.object({
    chats: z.number().int().nonnegative(),
    runs: z.number().int().nonnegative(),
  }),
);

export type UpdateInfo = z.infer<typeof updateInfo>;
export type UpdateSnapshot = z.infer<typeof snapshot>;
export type RunningWork = z.infer<typeof runningWork>;

export const updateClient = {
  async state() {
    return snapshot.parse(await invoke("updates_state"));
  },
  listen(changed: (state: UpdateSnapshot) => void) {
    return listen("ticketd://update-state", ({ payload }) => {
      const state = snapshot.safeParse(payload);
      if (state.success) changed(state.data);
    });
  },
  async setAutomatic(enabled: boolean) {
    return snapshot.parse(await invoke("updates_set_automatic", { enabled }));
  },
  check: () => invoke<void>("updates_check"),
  dismiss: (version: string) => invoke<void>("updates_dismiss", { version }),
  async restartDetails(version: string) {
    return runningWork.parse(
      await invoke("updates_restart_details", { version }),
    );
  },
  install: (version: string) => invoke<void>("updates_install", { version }),
};
