import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Info, Square, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OverlayBoundary } from "@/components/ui/overlay-boundary";
import type { TranscriptItem } from "@/features/chats/client";
import { duration, turnStatus } from "@/features/chats/model";
import { InSubAgent } from "@/features/chats/SubAgentRow";
import type { Ending, SubAgentViewData } from "@/features/chats/sub-agents";
import {
  JumpToLatest,
  markerText,
  Transcript,
  useNow,
  type TranscriptActions,
} from "@/features/chats/Transcript";
import {
  ReadingContext,
  useTranscriptScroll,
} from "@/features/chats/use-transcript-scroll";

/** What takes an Esc before the view does: menus, popovers, dialogs, pickers. */
const LAYER =
  '[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"]';

/**
 * Back from a sub-agent's view by keyboard: Cmd+[ (Ctrl+[), or Esc when no
 * menu, popover or request has the key. Never stops anything.
 */
export function backKey(event: KeyboardEvent<HTMLElement>, onBack: () => void) {
  if (event.nativeEvent.isComposing || event.defaultPrevented) return;
  const back =
    event.key === "Escape" ||
    (event.key === "[" && (event.metaKey || event.ctrlKey));
  if (!back) return;
  const target = event.target as Element;
  if (
    event.key === "Escape" &&
    (target.closest(LAYER) ||
      document.querySelector(LAYER) ||
      target.closest(".chat-tray"))
  )
    return;
  event.preventDefault();
  onBack();
}

/** The sentence a StopReason is told by in the transcript, without its edits clause. */
function stoppedWords(reason: string, harness: string) {
  const words = markerText(
    {
      id: "",
      at: "",
      kind: "marker",
      reason: reason as "quit",
    },
    harness,
    false,
  );
  const first = words?.split(/(?<=\.) /)[0];
  return first && first.length > 0 ? first : undefined;
}

/** How a sub-agent ended, as one step-style row under its last words. */
export function endingWords(ending: Ending, harness: string) {
  if (ending.kind === "lost")
    return {
      text: `Contact lost when ticketd quit.${ending.resumable ? ` ${harness} can resume it.` : ""}`,
      icon: "unplug" as const,
    };
  const text =
    ending.by === "person"
      ? "You stopped it."
      : ending.by === "main_agent"
        ? "The main agent stopped it."
        : ending.by === "ticketd"
          ? ((ending.reason && stoppedWords(ending.reason, harness)) ??
            "ticketd stopped it.")
          : "Stopped.";
  return { text, icon: "square" as const };
}

/** The brief the main agent gave the sub-agent, where a message would be. */
function Brief({ view }: { view: SubAgentViewData }) {
  const { brief } = view;
  const text = useRef<HTMLQuoteElement>(null);
  const [open, setOpen] = useState(false);
  // Four lines, then Show more; only a brief that is cut has the control.
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const box = text.current;
    if (box && !open) setCut(box.scrollHeight > box.clientHeight + 1);
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

/** The view's tray: only what there is to act on; with nothing, no tray. */
function Tray({ children }: { children: ReactNode }) {
  return children ? <div className="chat-tray">{children}</div> : null;
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
        {elapsed >= 1000 && ` · ${duration(elapsed)}`}
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
  tray,
}: {
  view: SubAgentViewData;
  items: TranscriptItem[];
  actions: TranscriptActions;
  tray?: ReactNode;
}) {
  const { chat, agent } = view;
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const { root, content, marker, following, reading, follow, onScroll } =
    useTranscriptScroll(`${chat.id}/${agent.id}`);
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
                      {view.limits && (
                        <div className="chat-part" data-kind="note">
                          <p className="chat-line chat-note chat-subagent-note">
                            <Info size={16} aria-hidden />
                            <span>
                              {chat.harness.name} doesn&apos;t report a
                              sub-agent&apos;s messages or when it finishes, and
                              can&apos;t stop one alone. ticketd shows its steps
                              and counts it as ended when the turn ends.
                            </span>
                          </p>
                        </div>
                      )}
                    </>
                  }
                  trail={
                    ending && (
                      <div data-anchor="">
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
            {turnStatus(
              chat,
              items.filter((item) => item.owner === agent.id),
            )}
          </div>
          <Tray>{tray}</Tray>
        </div>
      </div>
    </OverlayBoundary>
  );
}
