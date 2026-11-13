import { LoaderCircle } from "lucide-react";
import { StatusDot } from "@/components/ui/status-dot";
import type { Activity, ChatStatus as Status } from "@/features/chats/client";
import { waits } from "@/features/chats/model";

/**
 * A Chat's ranked status as one line: an 8px dot (orange waits for you, blue
 * unread) or the 12px spinner while it works, the word, then the muted detail,
 * which truncates first. The host words it; this only draws it.
 */
export function ChatStatus({
  status,
  activity,
}: {
  status: Status;
  activity: Activity;
}) {
  const working =
    status.rank === "working" &&
    (activity === "working" || activity === "waiting") &&
    status.word === "Working";
  return (
    <span className="chat-status">
      {waits(status) ? (
        <StatusDot tone="attention" />
      ) : status.unseen ? (
        <StatusDot tone="unread" />
      ) : (
        working && (
          <LoaderCircle size={12} className="chat-spin" aria-hidden="true" />
        )
      )}
      <span className="chat-status-word">{status.word}</span>
      {status.detail && (
        <span className="chat-status-detail">
          {"\u00a0· "}
          {status.detail}
        </span>
      )}
    </span>
  );
}
