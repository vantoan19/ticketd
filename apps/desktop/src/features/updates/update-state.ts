import { createContext, createElement, useContext } from "react";
import { Download } from "lucide-react";
import { StatusDot } from "@/components/ui/status-dot";
import type { StatusLineMessage } from "@/components/ui/use-status-line";
import type { UpdateInfo, UpdateSnapshot } from "./client";
import { workspaceClient } from "@/lib/api/workspace";

export const initialUpdateState: UpdateSnapshot = {
  revision: -1,
  automatic: true,
  dismissed: false,
  status: "idle",
};

export const UpdatesContext = createContext<{
  snapshot: UpdateSnapshot;
  setAutomatic: (enabled: boolean) => Promise<void>;
  openRestart: (update: UpdateInfo) => void;
  dismiss: (version: string) => Promise<void>;
} | null>(null);

export function useUpdates() {
  return useContext(UpdatesContext);
}

export function useUpdateNotice(): StatusLineMessage | undefined {
  const updates = useUpdates();
  if (!updates || updates.snapshot.dismissed) return;
  const { snapshot } = updates;
  const dismiss = (version: string) => () =>
    void updates.dismiss(version).catch(() => {});
  switch (snapshot.status) {
    case "ready":
      return {
        message: `ticketd ${snapshot.update.version} is ready`,
        icon: createElement(StatusDot, { tone: "unread", size: 10 }),
        action: {
          label: "Restart to update",
          run: () => updates.openRestart(snapshot.update),
        },
        secondaryAction: {
          label: "What’s new",
          run: () => workspaceClient.openLink(snapshot.update.release_url),
        },
        onDismiss: dismiss(snapshot.update.version),
      };
    case "manual_install":
      return {
        message: `ticketd ${snapshot.update.version} is available`,
        icon: createElement(Download),
        action: {
          label: "Download .deb",
          run: () => workspaceClient.openLink(snapshot.update.release_url),
        },
        onDismiss: dismiss(snapshot.update.version),
      };
    case "download_failed":
      return {
        tone: "error",
        message: snapshot.verification_failed
          ? `Couldn’t verify ticketd ${snapshot.update.version}, so it wasn’t installed.`
          : `Couldn’t download ticketd ${snapshot.update.version}.`,
        details: snapshot.error,
        action: {
          label: "Download",
          run: () => workspaceClient.openLink(snapshot.update.release_url),
        },
        onDismiss: dismiss(snapshot.update.version),
      };
    default:
      return;
  }
}
