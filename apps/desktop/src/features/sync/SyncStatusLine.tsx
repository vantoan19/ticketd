import { useRef, useState, type ReactNode } from "react";
import {
  CloudDownload,
  CloudOff,
  CloudUpload,
  GitCompareArrows,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
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
import { FailureAlert } from "@/components/ui/failure-alert";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { syncApi, type SyncReviewItem, type SyncStatus } from "@/lib/sync-api";
import { useNow } from "@/lib/use-now";
import { storageName } from "./storage-name";
import { recoveryCopy } from "./sync-recovery";
import { changes, pendingCount, useSyncStatus } from "./sync-status";
import "./sync.css";

type Line = {
  /** The dot beside the label; none while work is in progress. */
  tone: StatusDotTone | null;
  /** Short enough for the footer: 160px beside the dot, about 22 characters. */
  label: string;
  /** The whole sentence, when the label is a shortened one. */
  full?: string;
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
  automation_agent: ["agent", "agents"],
  automation: ["Automation", "Automations"],
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

/** The same without the kind, which does not fit the footer: "1 needs review". */
const needsReviewShort = (count: number) =>
  count === 1 ? "1 needs review" : `${count} need review`;

/** What the footer line and its popover say. The core decides the state; this only picks wording. */
function describe(status: SyncStatus, now: number): Line {
  const synced = status.last_synced_at
    ? (ago(status.last_synced_at, now) ?? status.last_synced_at)
    : null;
  const lastSynced = synced ? `Last synced ${synced}` : "Not synced yet";
  const waiting = pendingCount(status);
  const storage = storageName(status.provider).short;
  const safe = "Everything is saved on this computer";
  // Neither needs a decision: sync tries again by itself.
  const paused =
    status.recovery === "offline"
      ? "Offline"
      : status.recovery === "rate_limited"
        ? `${storage} is busy`
        : null;
  const recovery = recoveryCopy(status);
  // "Offline · 3 changes waiting": why nothing uploads, and how much waits.
  const held = [paused, waiting && `${changes(waiting)} waiting`]
    .filter(Boolean)
    .join(" · ");
  const heldItems = waiting
    ? [{ icon: <CloudOff />, text: `${changes(waiting)} waiting to upload` }]
    : [];
  switch (status.state) {
    case "uploaded":
      return {
        tone: "positive",
        label: `${storage} synced`,
        detail: synced ?? "Not synced yet",
        title: `${storage} synced`,
        description: lastSynced,
        items: [],
      };
    case "upload_pending":
      return {
        tone: null,
        label: waiting ? `Uploading ${changes(waiting)}…` : "Uploading…",
        detail: "Saved on this computer",
        title: `Uploading to ${storage}`,
        description: safe,
        items: waiting
          ? [{ icon: <CloudUpload />, text: `${changes(waiting)} uploading` }]
          : [],
      };
    case "saved_locally":
      return {
        tone: "neutral",
        label: "Saved on this computer",
        detail: held || "Not uploaded yet",
        title: paused ?? "Saved on this computer",
        description: safe,
        items: heldItems,
      };
    case "attachment_download_pending": {
      const { count, bytes_left } = status.attachment_downloads;
      return {
        tone: null,
        label: `Downloading ${count} ${count === 1 ? "file" : "files"}…`,
        detail: `${formatSize(bytes_left)} left`,
        title: `${storage} synced`,
        description: lastSynced,
        items: [
          {
            icon: <CloudDownload />,
            text: `${count} ${count === 1 ? "file" : "files"} downloading`,
          },
        ],
      };
    }
    case "needs_attention":
      // Being offline or slowed down mends itself, so it never takes the line
      // from what waits for the person: it is named beside it.
      if (recovery && !paused)
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
          ? needsReviewShort(status.needs_review.length)
          : "Sync needs attention",
        ...(status.needs_review.length
          ? { full: needsReview(status.needs_review) }
          : {}),
        detail: paused ? held : synced ? `Synced ${synced}` : "Not synced yet",
        title: status.needs_review.length
          ? needsReview(status.needs_review)
          : "Needs attention",
        description: [
          paused,
          status.needs_review.length
            ? "Changed on two desktops"
            : "The Inbox says what happened",
        ]
          .filter(Boolean)
          .join(" · "),
        items: [
          ...status.needs_review.map((item) => ({
            icon: <GitCompareArrows />,
            text: item.title,
          })),
          ...(paused ? heldItems : []),
        ],
      };
  }
}

/**
 * The storage line in the sidebar footer: one target. It opens a popover with
 * the state and its action (Review, Reconnect, Retry, Sync now); no second
 * button beside the line does a related thing (set SR-08).
 */
export function SyncStatusLine() {
  const now = useNow();
  const { status, apply, openSettings, openReview } = useSyncStatus();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Set at once, where `busy` waits for a render.
  const running = useRef(false);
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  if (!status) return null;
  const line = describe(status, now);
  const recovery = recoveryCopy(status);
  // Offline mends itself, so it asks for nothing on the line; its popover still offers a retry.
  const stopped =
    status.recovery === "service_changed" ||
    status.recovery === "cli_unavailable";
  // A changed S3 service is left by Disconnect, and a missing aws program is chosen, both on
  // the Settings page; the line itself can only retry, for a person who put it right.
  const corrective =
    status.state === "needs_attention" && recovery
      ? stopped
        ? "Retry"
        : recovery.action
      : null;
  const selfMending =
    status.recovery === "offline" || status.recovery === "rate_limited";
  // A waiting conflict is reviewed whatever else holds sync up, unless that needs the person first.
  const review =
    status.state === "needs_attention" &&
    (!recovery || (selfMending && status.needs_review.length > 0));
  const reviewNow = () => {
    setOpen(false);
    openReview();
  };
  /** `action` says what did not happen: "sync". */
  async function run(command: () => Promise<SyncStatus>, action: string) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setFailure(null);
    try {
      apply(await command());
    } catch (reason) {
      setFailure(describeFailure(reason, action));
      // The failure is read in the popover, also when the line's own button caused it.
      setOpen(true);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  const recover = () =>
    void run(
      syncApi.recover,
      !corrective || corrective === "Retry" ? "sync" : corrective.toLowerCase(),
    );
  return (
    <div className="sidebar-source sidebar-sync">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="sidebar-source-line"
            aria-label={line.full && `${line.full}, ${line.detail}`}
          >
            <span className="sidebar-source-label">
              {line.tone && <StatusDot tone={line.tone} size={10} />}
              {/* The full wording when the label is short for it, else the
                  label itself once it is cut. */}
              <Tooltip
                content={line.full ?? line.label}
                overflowOnly={!line.full}
              >
                <span className="sync-line-text">{line.label}</span>
              </Tooltip>
            </span>
            <small className="sync-line-text">{line.detail}</small>
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          aria-label={`${storageName(status.provider).full} sync`}
        >
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
            {failure && <FailureAlert size="compact" failure={failure} />}
            <div className="sync-popover-actions">
              {review ? (
                <>
                  <Button size="sm" onClick={reviewNow}>
                    Review
                  </Button>
                  {corrective && (
                    <Button
                      variant="outline"
                      size="sm"
                      busy={busy}
                      onClick={recover}
                    >
                      {busy && recovery?.working
                        ? recovery.working
                        : corrective}
                    </Button>
                  )}
                </>
              ) : corrective ? (
                <Button size="sm" busy={busy} onClick={recover}>
                  {busy && recovery?.working ? recovery.working : corrective}
                </Button>
              ) : (
                <Button
                  size="sm"
                  busy={busy}
                  onClick={() => void run(syncApi.syncNow, "sync")}
                >
                  <RefreshCw aria-hidden="true" />
                  Sync now
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
                {status.recovery === "service_changed"
                  ? "Disconnect in Settings"
                  : stopped
                    ? "Choose the aws program in Settings"
                    : "Settings"}
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
