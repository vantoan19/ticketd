import { useEffect, useRef, useState } from "react";
import {
  Bot,
  FileText,
  Folder,
  Layers,
  Paperclip,
  Ticket,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { DialogShell } from "@/components/ui/dialog-shell";
import { Item } from "@/components/ui/item";
import { Progress } from "@/components/ui/progress";
import { Reference } from "@/components/ui/reference";
import { windowClient } from "@/lib/api/window";
import { syncApi, type SyncPendingItem } from "@/lib/sync-api";
import { pendingCount, useSyncStatus } from "./sync-status";
import "./sync.css";

const ICONS: Record<SyncPendingItem["kind"], LucideIcon> = {
  ticket: Ticket,
  document: FileText,
  plan: Layers,
  project: Folder,
  automation_agent: Bot,
  automation: Workflow,
  attachment: Paperclip,
};

/** `count` is how many uploads wait; `pending` may list only the first of them. */
type Exit =
  /** The flush is running; `total` is what was pending when it started. */
  | {
      phase: "finishing";
      total: number;
      count: number;
      pending: SyncPendingItem[];
    }
  /** The flush ended with work left. Stays until the person answers. */
  | { phase: "unfinished"; count: number; pending: SyncPendingItem[] };

/**
 * Closing the window while changes are still uploading: the core gets up to 10
 * seconds to finish, and the app closes once nothing is left. If work is left
 * when the time is up, the dialog stays so that what did not upload is seen
 * before quitting.
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
            const total = pendingCount(now);
            if (now.connection !== "connected" || total === 0)
              return windowClient.quit();
            setExit({ phase: "finishing", total, count: total, pending });
            const left = await syncApi
              .flushOnExit()
              .then((report) => ({
                pending: report.pending,
                count: report.pending_total ?? report.pending.length,
              }))
              // Unknown is not uploaded: show what was pending.
              .catch(() => ({ pending, count: total }));
            if (current !== attempt.current) return;
            if (left.count === 0) return windowClient.quit();
            setExit({ phase: "unfinished", ...left });
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
  const waiting = finishing && status ? pendingCount(status) : exit.count;
  const count = exit.count;
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
          ? "Everything is saved on this computer. ticketd closes when the upload is done. If uploads are left after 10 seconds, it asks before closing."
          : count === 1
            ? "It is saved on this computer and uploads the next time ticketd is open."
            : "They are saved on this computer and upload the next time ticketd is open."
      }
      primaryLabel={finishing ? "Quit now" : "Quit"}
      primaryVariant="destructive"
      cancelLabel="Keep open"
      showClose={false}
      initialFocus="primary"
      blockedReason={null}
      size="sm"
      onSubmit={() => void windowClient.quit()}
    >
      {exit.phase === "finishing" && (
        <div className="sync-progress-row" role="status">
          <Progress
            aria-label="Upload"
            value={Math.max(exit.total - waiting, 0)}
            max={exit.total}
          />
          <span>
            {Math.max(exit.total - waiting, 0)} of {exit.total} uploaded
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
        {waiting > pending.length && (
          <Item asChild>
            <li>and {waiting - pending.length} more</li>
          </Item>
        )}
      </ul>
    </DialogShell>
  );
}
