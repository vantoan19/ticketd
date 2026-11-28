import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Info, Square, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OverlayBoundary } from "@/components/ui/overlay-boundary";
import type { TranscriptItem } from "@/features/chats/client";
import {
  duration,
  requestLabel,
  turnStatus,
  type PendingRequest,
} from "@/features/chats/model";
import { useNow } from "@/features/chats/use-now";
import { InSubAgent } from "@/features/chats/sub-agent-context";
import { endingWords } from "@/features/chats/sub-agent-words";
import type { SubAgentViewData } from "@/features/chats/sub-agents";
import {
  JumpToLatest,
  Transcript,
  type TranscriptActions,
} from "@/features/chats/Transcript";
import {
  ReadingContext,
  useTranscriptScroll,
} from "@/features/chats/use-transcript-scroll";

/** The brief the main agent gave the sub-agent, where a message would be. */
function Brief({ view }: { view: SubAgentViewData }) {
  const { brief } = view;
  const text = useRef<HTMLQuoteElement>(null);
  const [open, setOpen] = useState(false);
  // Four lines, then Show more; only a brief that is cut has the control.
  const [cut, setCut] = useState(false);
  // Measured again when the pane changes width: a brief that fit can be cut.
  useLayoutEffect(() => {
    const box = text.current;
    if (!box || open) return;
    const measure = () => setCut(box.scrollHeight > box.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [brief.text, open]);
  return (
    <div className="chat-part" data-kind="brief" data-anchor="">
      <figure className="chat-brief">
        <figcaption className="chat-brief-source">{brief.source}</figcaption>
        {brief.text && (
          <blockquote
            ref={text}
            className="chat-brief-text"
            data-open={open ? "" : undefined}
            data-unreported={brief.reported ? undefined : ""}
          >
            {brief.text}
          </blockquote>
        )}
        {(cut || open) && (
          <button
            type="button"
            className="chat-brief-more"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? "Show less" : "Show more"}
          </button>
        )}
      </figure>
    </div>
  );
}

/** "Working · 2m 10s" with Stop, for a sub-agent the harness can stop alone. */
export function SubAgentControl({
  view,
  onStop,
}: {
  view: SubAgentViewData;
  onStop: () => void;
}) {
  const { agent } = view;
  const now = useNow(agent.status === "running");
  const started = Date.parse(agent.started_at);
  const elapsed = now - started;
  return (
    <div className="chat-subagent-foot" role="status" aria-live="polite">
      <span className="chat-subagent-foot-words">
        {view.items.some((item) => item.kind !== "turn")
          ? "Working"
          : "Starting"}
        {/* The live region says the state; the clock ticks without being read. */}
        {elapsed >= 1000 && (
          <span aria-hidden="true"> · {duration(elapsed)}</span>
        )}
      </span>
      <span className="chat-spacer" />
      <Button
        variant="ghost"
        size="compact"
        aria-label={`Stop ${agent.title}`}
        onClick={onStop}
      >
        <Square className="chat-stop-mark" fill="currentColor" aria-hidden />
        Stop
      </Button>
    </div>
  );
}

/**
 * A sub-agent's read-only view, in the Chat's pane: its brief, then its work in
 * the turn's own parts, then how it ended. It has no composer. Its tray holds
 * only what there is to act on (requests, another agent that needs you, Stop),
 * which later slices fill; with none there is no tray. Back (the crumb, Cmd+[ or
 * Esc when nothing else has the key) never stops anything.
 */
export function SubAgentView({
  view,
  items,
  actions,
  historyControl,
  tray,
}: {
  view: SubAgentViewData;
  items: TranscriptItem[];
  actions: TranscriptActions;
  historyControl?: ReactNode;
  tray?: ReactNode;
}) {
  const { chat, agent } = view;
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const { root, content, marker, following, reading, follow, onScroll } =
    useTranscriptScroll(`${chat.id}/${agent.id}`);
  const ownRequest = items.find(
    (item): item is PendingRequest =>
      item.kind === "request" &&
      item.state === "pending" &&
      item.owner === agent.id,
  );
  const ending = view.ending && endingWords(view.ending, chat.harness.name);
  return (
    <OverlayBoundary element={body}>
      <div ref={setBody} className="chat-body">
        <div className="chat-reading">
          <ReadingContext value={reading}>
            <div
              ref={root}
              className="chat-scroll"
              tabIndex={0}
              aria-label="Conversation"
              onScroll={onScroll}
            >
              <InSubAgent value>
                <Transcript
                  chat={chat}
                  items={view.items}
                  parts={view.parts}
                  actions={actions}
                  readOnly
                  markerRef={marker}
                  contentRef={content}
                  lead={
                    <>
                      <Brief view={view} />
                      {historyControl}
                      {view.limits && (
                        <div className="chat-part" data-kind="note">
                          <p className="chat-line chat-note chat-subagent-note">
                            <Info size={16} aria-hidden />
                            <span>
                              {`${chat.harness.name} doesn't report a sub-agent's messages or when it finishes, and can't stop one alone. ticketd shows its steps and counts it as ended when the turn ends.`}
                            </span>
                          </p>
                        </div>
                      )}
                    </>
                  }
                  trail={
                    ending && (
                      <div className="chat-end" data-anchor="">
                        <p className="chat-line chat-end-marker">
                          <span className="chat-row-icon" aria-hidden="true">
                            {ending.icon === "unplug" ? (
                              <Unplug size={16} />
                            ) : (
                              <Square
                                size={12}
                                fill="currentColor"
                                className="chat-stop-mark"
                              />
                            )}
                          </span>
                          <span>{ending.text}</span>
                        </p>
                      </div>
                    )
                  }
                />
              </InSubAgent>
            </div>
          </ReadingContext>
          <JumpToLatest shown={!following} onJump={() => follow()} />
        </div>
        <div className="chat-dock">
          <div className="sr-only" aria-live="polite">
            {ownRequest
              ? requestLabel(ownRequest, undefined, agent.title)
              : turnStatus(
                  chat,
                  items.filter((item) => item.owner === agent.id),
                )}
          </div>
          {tray}
        </div>
      </div>
    </OverlayBoundary>
  );
}
