import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import { CrossfadeText } from "@/components/ui/motion";
import { StatusDot } from "@/components/ui/status-dot";
import type { Activity, ChatStatus as Status } from "@/features/chats/client";
import { needsYou } from "@/features/chats/model";

/**
 * A Chat's ranked status as one line: an 8px dot (orange needsYou for you, blue
 * unread) or the 12px spinner while it works, the word, then the muted detail,
 * which truncates first. The host words it; this only draws it. When the status
 * changes in view the dot arrives and the word crossfades.
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
  const signal = needsYou(status) || status.unseen || working;
  const dot = needsYou(status) ? "attention" : status.unseen ? "unread" : null;
  // A dot that was not there when the line was first drawn fades in.
  const [first] = useState(dot);
  const arrived = dot !== null && dot !== first;
  return (
    <span
      className="chat-status"
      data-signal={signal ? "" : undefined}
      data-arrived={arrived ? "" : undefined}
    >
      {dot ? (
        <StatusDot key={dot} tone={dot} />
      ) : (
        working && (
          <LoaderCircle size={12} className="chat-spin" aria-hidden="true" />
        )
      )}
      <span className="chat-status-word">
        <CrossfadeText>{status.word}</CrossfadeText>
      </span>
      {status.detail && (
        <span className="chat-status-detail">
          {" · "}
          {status.detail}
        </span>
      )}
    </span>
  );
}
