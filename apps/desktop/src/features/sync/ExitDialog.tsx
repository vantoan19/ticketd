import { useEffect, useRef, useState } from "react";
import {
  FileText,
  Folder,
  Layers,
  Paperclip,
  Ticket,
  type LucideIcon,
} from "lucide-react";
import { DialogShell } from "@/components/ui/dialog-shell";
import { Item } from "@/components/ui/item";
import { Progress } from "@/components/ui/progress";
import { Reference } from "@/components/ui/reference";
import { windowClient } from "@/lib/api/window";
import { syncApi, type SyncPendingItem } from "@/lib/sync-api";
import { useSyncStatus } from "./sync-status";
import "./sync.css";

const ICONS: Record<SyncPendingItem["kind"], LucideIcon> = {
  ticket: Ticket,
  document: FileText,
  plan: Layers,
  project: Folder,
  attachment: Paperclip,
};

type Exit =
  /** The flush is running; `total` is what was pending when it started. */
  | { phase: "finishing"; total: number; pending: SyncPendingItem[] }
  /** The flush ended with work left. Stays until the person answers. */
  | { phase: "unfinished"; pending: SyncPendingItem[] };

/**
 * Closing the window while changes are still uploading: the core gets up to 10
 * seconds to finish, then the app closes. If work is left when the time is up,
 * the dialog stays so that what did not upload is seen before quitting.
 */
export function ExitDialog() {
  const { status, refresh } = useSyncStatus();
  const [exit, setExit] = useState<Exit | null>(null);
  // Counts close requests, so a flush the person walked away from cannot quit the app.
  const attempt = useRef(0);
  const latest = useRef(refresh);
  useEffect(() => {
    latest.current = refresh;
  });
  useEffect(
    () =>
      windowClient.guardClose(() => {
        const current = ++attempt.current;
        void latest
          .current()
          .then(async (now) => {
            const pending = now.pending_uploads;
            if (now.connection !== "connected" || pending.length === 0)
              return windowClient.quit();
            setExit({ phase: "finishing", total: pending.length, pending });
            const left = await syncApi
              .flushOnExit()
              .then((report) => report.pending)
              // Unknown is not uploaded: show what was pending.
              .catch(() => pending);
            if (current !== attempt.current) return;
            if (left.length === 0) return windowClient.quit();
            setExit({ phase: "unfinished", pending: left });
          })
          // Sync cannot be asked, so there is nothing to wait for.
          .catch(() => windowClient.quit());
      }),
    [],
  );
  if (!exit) return null;
  const finishing = exit.phase === "finishing";
  // The status poll keeps the list current while the flush runs.
  const pending = finishing && status ? status.pending_uploads : exit.pending;
  const count = exit.pending.length;
  return (
    <DialogShell
      open
      onOpenChange={(open) => {
        if (open) return;
        attempt.current += 1;
        setExit(null);
      }}
      title={
        finishing
          ? "Finishing upload"
          : `${count} ${count === 1 ? "upload" : "uploads"} did not finish`
      }
      description={
        finishing
          ? "Everything is saved on this computer. ticketd closes when the upload is done, or in 10 seconds."
          : count === 1
            ? "It is saved on this computer and uploads the next time ticketd is open."
            : "They are saved on this computer and upload the next time ticketd is open."
      }
      primaryLabel={finishing ? "Quit now" : "Quit"}
      cancelLabel="Keep open"
      showClose={false}
      blockedReason={null}
      width={480}
      onSubmit={() => void windowClient.quit()}
    >
      {exit.phase === "finishing" && (
        <div className="sync-progress-row" role="status">
          <Progress
            aria-label="Upload"
            value={Math.max(exit.total - pending.length, 0)}
            max={exit.total}
          />
          <span>
            {Math.max(exit.total - pending.length, 0)} of {exit.total} uploaded
          </span>
        </div>
      )}
      <ul className="sync-pending" aria-label="Still uploading">
        {pending.map((item, index) => {
          const Icon = ICONS[item.kind];
          return (
            <Item asChild key={index}>
              <li>
                <Icon aria-hidden="true" />
                {item.reference && <Reference>{item.reference}</Reference>}
                <span className="sync-pending-title">{item.title}</span>
              </li>
            </Item>
          );
        })}
      </ul>
    </DialogShell>
  );
}
