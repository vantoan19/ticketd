import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import { CrossfadeText } from "@/components/ui/motion";
import { StatusDot } from "@/components/ui/status-dot";
import type { Activity, ChatStatus as Status } from "@/features/chats/client";
import { needsYou } from "@/features/chats/model";
import { lead } from "@/lib/motion-tokens";

/**
 * A Chat's ranked status as one line: an 8px dot (orange needsYou for you, blue
 * unread), the word, then the muted detail, which truncates first. Work is the
 * word "Working" in ink with no spinner: the sidebar and the open Chat's live line
 * each keep the one that moves; a menu opts in with `spinner`. The host words it; this only draws it. When the status
 * changes in view the dot arrives first, then the word crossfades.
 */
export function ChatStatus({
  status,
  activity,
  spinner = false,
}: {
  status: Status;
  activity: Activity;
  /** A menu has no live line or sidebar count beside it, so its working row keeps the spinner. */
  spinner?: boolean;
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
        spinner &&
        working && (
          <LoaderCircle size={12} className="chat-spin" aria-hidden="true" />
        )
      )}
      <span className="chat-status-word">
        <CrossfadeText delay={arrived ? lead() : 0}>
          {status.word}
        </CrossfadeText>
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
