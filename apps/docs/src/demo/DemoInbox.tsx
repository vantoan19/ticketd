import { CheckCheck, MessageSquare } from "lucide-react";
import type { ReactNode } from "react";
import { Reference } from "@desktop/components/ui/reference";
import { StatusIcon } from "@desktop/features/tickets/StatusIcon";
import {
  needsReview,
  summary,
  type DemoEntry,
  type EntryId,
} from "./inbox-model";
import { featureRef, type Stage } from "./workspace";

export function DemoInbox({
  entries,
  stage,
  readEntries,
  title,
  markRead,
  open,
}: {
  entries: DemoEntry[];
  stage: Stage;
  readEntries: readonly EntryId[];
  title: ReactNode;
  markRead: () => void;
  open: (id: EntryId) => void;
}) {
  const unread = entries.some((entry) => !readEntries.includes(entry.id));
  return (
    <>
      <div className="demo-pane-title">
        {title}
        {entries.length > 0 && (
          <button
            type="button"
            className="demo-tool"
            aria-disabled={!unread}
            onClick={() => unread && markRead()}
          >
            <CheckCheck size={12} />
            {unread ? "Mark all read" : "All read"}
          </button>
        )}
      </div>
      <div className="demo-inbox">
        {(["Needs you", "Updates"] as const).map((group) => {
          const items = entries.filter(
            (entry) => needsReview(entry, stage) === (group === "Needs you"),
          );
          if (!items.length) return null;
          return (
            <div key={group} className="demo-inbox-group">
              <p>
                {group}
                <span>{items.length}</span>
              </p>
              {items.map((entry) => (
                <button
                  key={entry.id}
                  data-demo-control={entry.id}
                  type="button"
                  onClick={() => open(entry.id)}
                >
                  <i
                    data-unread={!readEntries.includes(entry.id)}
                    aria-hidden="true"
                  />
                  {entry.kind === "activity" ? (
                    <MessageSquare size={14} aria-hidden="true" />
                  ) : (
                    <StatusIcon status={entry.to} decorative size={14} />
                  )}
                  <span>
                    <span className="demo-entry-title">
                      <Reference>{featureRef}</Reference>Rate-limit API requests
                    </span>
                    <small>{summary(entry, stage)}</small>
                  </span>
                  {!readEntries.includes(entry.id) && (
                    <span className="sr-only">Unread</span>
                  )}
                </button>
              ))}
            </div>
          );
        })}
        {!entries.length && (
          <p className="demo-empty">
            Updates to the followed limiter ticket will appear here.
          </p>
        )}
      </div>
    </>
  );
}
