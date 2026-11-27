import { useId, useState } from "react";
import { ChevronDown, Info, Unplug } from "lucide-react";
import type { ChatState, MessageNote } from "@/features/chats/client";

const agents = (n: number) => `${n} ${n === 1 ? "sub-agent" : "sub-agents"}`;

/**
 * The tray's neutral notice after ticketd quit while sub-agents ran: nothing
 * waits for the person, so no dot and no button. It says what the next message
 * does: tells the harness, which can resume them (Claude Code) or cannot (Codex).
 */
export function RestartNotice({
  notice,
  harness,
}: {
  notice: NonNullable<ChatState["restart_notice"]>;
  harness: string;
}) {
  const n = notice.sub_agents.length;
  if (n === 0) return null;
  return (
    <section className="chat-restart-notice" role="status">
      <p className="chat-restart-notice-title">
        <Unplug size={16} aria-hidden />
        <span>{`${agents(n)} lost contact when ticketd quit.`}</span>
      </p>
      <p className="chat-restart-notice-body">
        {`Your next message tells ${harness}${notice.resume ? `, which can resume ${n === 1 ? "it" : "them"}` : ""}.`}
      </p>
    </section>
  );
}

/**
 * Under a sent message: what ticketd added to it, one line that opens to the
 * exact note, so nothing is sent in the person's name unseen.
 */
export function NoteCaption({ note }: { note: MessageNote }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <div className="chat-caption">
        <button
          type="button"
          className="chat-note-caption"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={() => setOpen(!open)}
        >
          <Info size={14} aria-hidden />
          {`With a note on ${note.sub_agents.length} lost ${note.sub_agents.length === 1 ? "sub-agent" : "sub-agents"}`}
          <ChevronDown size={14} aria-hidden />
        </button>
      </div>
      {open && (
        <figure id={id} className="chat-brief chat-note-sent">
          <blockquote className="chat-brief-text">{note.text}</blockquote>
        </figure>
      )}
    </>
  );
}
