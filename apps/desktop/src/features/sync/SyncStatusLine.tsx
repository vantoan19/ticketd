import { useState, type ReactNode } from "react";
import {
  CloudDownload,
  CloudOff,
  CloudUpload,
  GitCompareArrows,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Item } from "@/components/ui/item";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { StatusDot, type StatusDotTone } from "@/components/ui/status-dot";
import { formatSize } from "@/features/attachments/format-size";
import { ago } from "@/features/tickets/ticket-source";
import { syncApi, type SyncReviewItem, type SyncStatus } from "@/lib/sync-api";
import { useNow } from "@/lib/use-now";
import { recoveryCopy } from "./sync-recovery";
import { changes, useSyncStatus } from "./sync-status";
import "./sync.css";

type Line = {
  /** The dot beside the label; none while work is in progress. */
  tone: StatusDotTone | null;
  label: string;
  detail: string;
  title: string;
  description: string;
  /** Pending work, listed only when there is some. */
  items: { icon: ReactNode; text: string }[];
};

const REVIEW_KINDS = {
  ticket: ["ticket", "tickets"],
  document: ["Document", "Documents"],
  plan: ["Plan", "Plans"],
  project: ["project", "projects"],
} as const;

/** "1 ticket needs review", "2 Documents need review", "3 records need review". */
function needsReview(items: SyncReviewItem[]): string {
  const first = items[0]?.kind ?? "ticket";
  const [one, many] = items.every((item) => item.kind === first)
    ? REVIEW_KINDS[first]
    : ["record", "records"];
  return items.length === 1
    ? `1 ${one} needs review`
    : `${items.length} ${many} need review`;
}

/** What the footer line and its popover say. The core decides the state; this only picks wording. */
function describe(status: SyncStatus, now: number): Line {
  const synced = status.last_synced_at
    ? (ago(status.last_synced_at, now) ?? status.last_synced_at)
    : null;
  const lastSynced = synced ? `Last synced ${synced}` : "Not synced yet";
  const waiting = status.pending_uploads.length;
  const safe = "Everything is saved on this computer";
  const offline = status.recovery === "offline";
  const recovery = recoveryCopy(status);
  switch (status.state) {
    case "uploaded":
      return {
        tone: "positive",
        label: "Drive synced",
        detail: synced ?? "Not synced yet",
        title: "Drive synced",
        description: lastSynced,
        items: [],
      };
    case "upload_pending":
      return {
        tone: null,
        label: waiting ? `Uploading ${changes(waiting)}…` : "Uploading…",
        detail: "Saved on this computer",
        title: "Uploading to Drive",
        description: safe,
        items: waiting
          ? [{ icon: <CloudUpload />, text: `${changes(waiting)} uploading` }]
          : [],
      };
    case "saved_locally":
      return {
        tone: "neutral",
        label: "Saved on this computer",
        detail:
          [offline && "Offline", waiting && `${changes(waiting)} waiting`]
            .filter(Boolean)
            .join(" · ") || "Not uploaded yet",
        title: offline ? "Offline" : "Saved on this computer",
        description: safe,
        items: waiting
          ? [
              {
                icon: <CloudOff />,
                text: `${changes(waiting)} waiting to upload`,
              },
            ]
          : [],
      };
    case "attachment_download_pending": {
      const { count, bytes_left } = status.attachment_downloads;
      return {
        tone: null,
        label: `Downloading ${count} ${count === 1 ? "file" : "files"}…`,
        detail: `${formatSize(bytes_left)} left`,
        title: "Drive synced",
        description: lastSynced,
        items: [
          {
            icon: <CloudDownload />,
            text: `${count} ${count === 1 ? "Attachment" : "Attachments"} downloading`,
          },
        ],
      };
    }
    case "needs_attention":
      if (recovery)
        return {
          tone: "attention",
          label: recovery.label,
          detail: "Saved on this computer",
          title: recovery.title,
          description: recovery.description,
          items: [],
        };
      return {
        tone: "attention",
        label: status.needs_review.length
          ? needsReview(status.needs_review)
          : "Sync needs attention",
        detail: synced ? `Synced ${synced}` : "Not synced yet",
        title: status.needs_review.length ? "Needs review" : "Needs attention",
        description: status.needs_review.length
          ? "Changed on two desktops"
          : "The Inbox says what happened",
        items: status.needs_review.map((item) => ({
          icon: <GitCompareArrows />,
          text: item.title,
        })),
      };
  }
}

/** The Drive line in the sidebar footer; it opens a popover with the state and its one action. */
export function SyncStatusLine() {
  const now = useNow();
  const { status, apply, openSettings, openReview } = useSyncStatus();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  if (!status) return null;
  const line = describe(status, now);
  const recovery = recoveryCopy(status);
  // Offline mends itself, so it asks for nothing on the line; its popover still offers a retry.
  const corrective =
    status.state === "needs_attention" && recovery ? recovery.action : null;
  const review = status.state === "needs_attention" && !recovery;
  async function run(command: () => Promise<SyncStatus>, failed: string) {
    setBusy(true);
    setFailure("");
    try {
      apply(await command());
    } catch (reason) {
      setFailure(
        `${failed}: ${reason instanceof Error ? reason.message : String(reason)}`,
      );
      // The failure is read in the popover, also when the line's own button caused it.
      setOpen(true);
    } finally {
      setBusy(false);
    }
  }
  const recover = () =>
    void run(syncApi.recover, `${corrective ?? "Retry"} did not work`);
  return (
    <div className="sidebar-source sidebar-sync">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className="sidebar-source-line">
            <span className="sidebar-source-label">
              {line.tone && <StatusDot tone={line.tone} size={10} />}
              {line.label}
            </span>
            <small>{line.detail}</small>
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" aria-label="Google Drive sync">
          <div className="sync-popover">
            <PopoverHeader>
              <PopoverTitle>{line.title}</PopoverTitle>
              <PopoverDescription>{line.description}</PopoverDescription>
            </PopoverHeader>
            {line.items.length > 0 && (
              <ul className="sync-status-list">
                {line.items.map((item, index) => (
                  <Item asChild key={index}>
                    <li>
                      {item.icon}
                      <span>{item.text}</span>
                    </li>
                  </Item>
                ))}
              </ul>
            )}
            {failure && (
              <p role="alert" className="settings-failure">
                {failure}
              </p>
            )}
            <div className="sync-popover-actions">
              {review ? (
                <Button
                  size="sm"
                  onClick={() => {
                    setOpen(false);
                    openReview();
                  }}
                >
                  Review
                </Button>
              ) : corrective ? (
                <Button size="sm" disabled={busy} onClick={recover}>
                  {corrective}
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void run(syncApi.syncNow, "Sync did not run")}
                >
                  <RefreshCw aria-hidden="true" />
                  {status.recovery === "offline" ? "Try now" : "Sync now"}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setOpen(false);
                  openSettings();
                }}
              >
                Settings
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
      {corrective && (
        <Button variant="ghost" size="sm" disabled={busy} onClick={recover}>
          {corrective}
        </Button>
      )}
    </div>
  );
}
