import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Maximize2,
  Minimize2,
  Trash2,
  X,
} from "lucide-react";
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FailureAlert, FailureState } from "@/components/ui/failure-alert";
import { IconButton } from "@/components/ui/icon-button";
import { useStatusLine } from "@/components/ui/use-status-line";
import { DocumentNavigation } from "@/features/documents/navigation";
import { ofTotal } from "@/lib/format";
import { OverlayBoundary } from "@/components/ui/overlay-boundary";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useCopy } from "@/components/ui/use-copy";
import { workspaceClient } from "@/lib/api/workspace";
import { PathText } from "@/components/ui/path-text";
import { withoutVerbatim } from "@/lib/paths";
import { ActivityDock } from "@/features/chats/ActivityDock";
import { focusFirstChoice } from "@/features/chats/dock-focus";
import { DockSlot } from "@/features/chats/DockSlot";
import {
  ChatError,
  useChatClient,
  type ChatSnapshot,
  type ChatState,
  type LinkedRecord,
  type Problem,
  type TranscriptItem,
} from "@/features/chats/client";
import { ChatActionsMenu } from "@/features/chats/ChatActionsMenu";
import { ChatContext, ContextCount } from "@/features/chats/ChatContext";
import { ComposerControls } from "@/features/chats/ComposerControls";
import {
  labelOf,
  settingLine,
  type AskedChange,
} from "@/features/chats/composer-settings";
import { HarnessMark } from "@/features/chats/HarnessMark";
import { Composer } from "@/features/chats/Composer";
import type { ComposerMentions } from "@/features/chats/ComposerField";
import { ComposerQuotes } from "@/features/chats/ComposerQuote";
import {
  arrivals,
  attachmentsOf,
  drafts,
  draftSubmissions,
  draftTokens,
  tokensOf,
} from "@/features/chats/drafts";
import {
  clearQuotes,
  quoteLinks,
  quotedMessage,
  useQuotes,
} from "@/features/chats/quotes";
import { ResumeDialog, SaveDocumentDialog } from "@/features/chats/dialogs";
import { chatFailure, type ChatFailureNotice } from "@/features/chats/failure";
import { lastAsk, runningPlan } from "@/features/chats/reports";
import { PlanPill } from "@/features/chats/TurnReports";
import { LinkPicker, RecordChip } from "@/features/chats/LinkPicker";
import {
  composerControls,
  composerPlaceholder,
  firstNew,
  unseenFrom,
  asStarting,
  isLive,
  problemNotice,
  requestLabel,
  turns,
  turnStatus,
  visibleChatProblem,
  type NoticeAction,
  type PendingRequest,
} from "@/features/chats/model";
import {
  JumpToLatest,
  Transcript,
  type TranscriptActions,
} from "@/features/chats/Transcript";
import {
  ReadingContext,
  useTranscriptScroll,
} from "@/features/chats/use-transcript-scroll";
import { useChat } from "@/features/chats/use-chats";

/**
 * Sets `code spans` of a notice's sentence in mono. A span that is `path` reads
 * as paths do elsewhere: one line, shortened in the middle. Punctuation right
 * after the path stays on the path's line, so a wrapped path never leaves a
 * line that starts with "." or ",".
 */
function NoticeText({ text, path }: { text: string; path?: string }) {
  const parts = text.split("`");
  const nodes: ReactNode[] = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index] ?? "";
    if (index % 2 === 0) {
      nodes.push(part);
    } else if (path && part === withoutVerbatim(path)) {
      const next = parts[index + 1] ?? "";
      const punctuation = /^[.,;:!?)]+/.exec(next)?.[0] ?? "";
      if (punctuation) parts[index + 1] = next.slice(punctuation.length);
      nodes.push(
        <span key={index} className="notice-path">
          <PathText path={path} layout="inline" />
          {punctuation}
        </span>,
      );
    } else {
      nodes.push(
        <code key={index} className="chat-mono">
          {part}
        </code>,
      );
    }
  }
  return nodes;
}

const ACTION_LABEL: Record<Exclude<NoticeAction, "help">, string> = {
  check: "Check again",
  "copy-command": "Copy command",
  resend: "Send again",
  discard: "Don't send",
  "pick-folder": "Choose a folder…",
  "start-fresh": "Start fresh",
  resume: "Resume in a fresh session…",
};

/**
 * The one notice about a problem: what is wrong and what the person can do.
 * `flat` draws it as a section of a surface that already has the ring (the
 * Chat's tray, the picker popover): no fill, ring or radius of its own.
 */
export function ProblemNotice({
  problem,
  harness,
  onAction,
  flat = false,
}: {
  problem: Problem;
  harness: string;
  onAction: (action: Exclude<NoticeAction, "help" | "copy-command">) => void;
  flat?: boolean;
}) {
  const notice = problemNotice(
    problem.path
      ? { ...problem, path: withoutVerbatim(problem.path) }
      : problem,
    harness,
  );
  const { copied, error, copy } = useCopy();
  return (
    <Alert tone={notice.tone} flat={flat}>
      <AlertTitle>{notice.title}</AlertTitle>
      <AlertDescription>
        <NoticeText
          text={notice.body}
          {...(problem.path && { path: problem.path })}
        />
      </AlertDescription>
      <AlertActions>
        {notice.actions.map((action) =>
          action === "help" ? (
            problem.help_url && (
              <Button
                key={action}
                variant="outline"
                size="sm"
                onClick={() =>
                  void workspaceClient
                    .openLink(problem.help_url ?? "")
                    .catch(() => {})
                }
              >
                {notice.help} <ArrowUpRight aria-hidden />
              </Button>
            )
          ) : action === "copy-command" ? (
            <Button
              key={action}
              variant="outline"
              size="sm"
              onClick={() => void copy("Command", problem.command ?? "")}
            >
              {copied ? "Copied" : ACTION_LABEL[action]}
            </Button>
          ) : (
            <Button
              key={action}
              variant="outline"
              size="sm"
              onClick={() => onAction(action)}
            >
              {ACTION_LABEL[action]}
            </Button>
          ),
        )}
        {error && <span className="chat-fine">{error}</span>}
      </AlertActions>
    </Alert>
  );
}

/**
 * The Chat's linked records on one line; what does not fit folds into
 * "N more", which lists them all. With no links there is no row: the Chat
 * actions menu links one.
 */
function LinkedRecords({
  chat,
  scrolled,
  onFailure,
}: {
  chat: ChatState;
  /** The transcript is scrolled under the strip: its boundary shows. */
  scrolled: boolean;
  onFailure: (failure: ChatFailureNotice | null) => void;
}) {
  const client = useChatClient();
  const line = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState(0);
  const links = chat.links;
  // Chips that wrapped below the first line are clipped; count them.
  useLayoutEffect(() => {
    const element = line.current;
    if (!element) return;
    const measure = () => {
      const chips = [...element.children] as HTMLElement[];
      const top = chips[0]?.offsetTop ?? 0;
      setHidden(chips.filter((chip) => chip.offsetTop > top).length);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [links]);
  const settle = (name: string, action: () => Promise<void>): void =>
    void action().then(
      () => onFailure(null),
      (reason: unknown) =>
        onFailure(chatFailure(reason, name, () => settle(name, action))),
    );
  const remove = (record: LinkedRecord) =>
    settle(`remove the link to ${record.title}`, () =>
      client.removeLink(chat.id, { kind: record.kind, id: record.id }),
    );
  const add = (record: LinkedRecord) =>
    settle(`link ${record.title}`, () =>
      client.addLink(chat.id, { kind: record.kind, id: record.id }),
    );
  if (links.length === 0) return null;
  return (
    <div className="chat-linked" data-scrolled={scrolled ? "" : undefined}>
      <div role="group" aria-label="Linked records">
        <div ref={line} className="chat-linked-line">
          {links.map((record) => (
            <RecordChip
              key={`${record.kind}:${record.id}`}
              record={record}
              backLabel={`Back to ${chat.title}`}
              onRemove={() => remove(record)}
            />
          ))}
        </div>
        {hidden > 0 && (
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="xs">
                {hidden} more
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" aria-label="Linked records">
              <div className="chat-linked-all">
                <h3>Linked records</h3>
                <ul>
                  {links.map((record) => (
                    <li key={`${record.kind}:${record.id}`}>
                      <RecordChip
                        record={record}
                        backLabel={`Back to ${chat.title}`}
                        onRemove={() => remove(record)}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            </PopoverContent>
          </Popover>
        )}
        <LinkPicker linked={links} onPick={add} />
      </div>
    </div>
  );
}

const isMessage = (item: TranscriptItem) =>
  item.kind === "user" || item.kind === "response";

/** What takes an Esc before the Chat does: menus, popovers, dialogs, pickers. */
const LAYER =
  '[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"]';
/** An Esc this soon after one that closed a layer never stops the turn. */
const ESC_AFTER_LAYER_MS = 1000;
/** How long scrolling pauses before what was read through is kept. */
const READ_THROUGH_MS = 250;

function Conversation({
  snapshot,
  focusRequest,
  onRequestsAnswered,
  notice,
}: {
  snapshot: ChatSnapshot;
  focusRequest: boolean;
  onRequestsAnswered?: () => void;
  notice?: ReactNode;
}) {
  const client = useChatClient();
  const { chat: reported, items } = snapshot;
  const id = reported.id;
  const harness = reported.harness.name;
  // Why text was carried into this Chat: a written sentence, said once.
  const [arrival, setArrival] = useState(() => arrivals.get(id) ?? "");
  const [failure, setFailure] = useState<ChatFailureNotice | null>(null);
  // Said once: the next time this Chat opens it starts without the reason.
  useEffect(() => void arrivals.delete(id), [id]);
  const [resuming, setResuming] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
  const [saving, setSaving] = useState<{
    id: string;
    text: string;
    plan?: boolean;
  } | null>(null);
  // A save as a Document is said in the pane's status line, with Open (CH-33).
  const statusLine = useStatusLine();
  const openDocument = useContext(DocumentNavigation);
  // The strip of linked records shows its boundary once the transcript is
  // scrolled under it (CH-10).
  const [scrolled, setScrolled] = useState(false);
  /** A model, effort or permission change asked for here, until the next send. */
  const [asked, setAsked] = useState<AskedChange | null>(null);
  const changeLine = settingLine(reported, asked);
  /**
   * Runs a command; a refusal is said once, and the view keeps the host's
   * state. `name` says what did not happen: "send the message".
   */
  const run = (
    action: Promise<unknown>,
    name: string,
    retry?: () => void,
    retryRequiresSend = false,
  ) =>
    action.then(
      () => {
        setFailure(null);
        setArrival("");
      },
      (reason: unknown) => {
        setFailure({ ...chatFailure(reason, name, retry), retryRequiresSend });
        throw reason;
      },
    );
  const quietly = (action: Promise<unknown>, name: string) =>
    void run(action, name).catch(() => {});
  const actions = useMemo<TranscriptActions>(
    () => ({
      saveAsDocument: (response) =>
        setSaving({ id: response.id, text: response.text }),
      savePlan: (plan) =>
        setSaving({
          id: plan.id,
          text: `Plan: ${plan.steps[0]?.text ?? ""}`,
          plan: true,
        }),
      openFile: (path) => client.openFile(id, path),
      exportAttachment: (file) => client.exportAttachment(id, file),
    }),
    [client, id],
  );
  // A message just sent shows its turn starting at once (LIVE-6).
  const chat = asStarting(reported, items);
  const parts = turns(items, chat);
  const problem = visibleChatProblem(chat.problem, parts);
  /** Running only in this view so far: Stop waits for the host to know of the turn. */
  const unconfirmedStart = chat !== reported;
  const plan = runningPlan(items);
  const turnStartedAt = lastAsk(items);
  const messageBox = useRef<HTMLTextAreaElement>(null);
  const retrySend = useRef<(() => void) | null>(null);
  const dock = useRef<HTMLDivElement>(null);
  // Opening a Chat whose opener left (a list row re-sorted, a pane swapped)
  // must not strand the keyboard on the page: the message box takes it.
  useEffect(() => {
    if (document.activeElement === document.body) messageBox.current?.focus();
  }, []);
  const [freshStarts, setFreshStarts] = useState(0);
  const handledFreshStart = useRef(0);
  const composerShown =
    chat.has_composer && !picked && chat.retention !== "trashed";
  useLayoutEffect(() => {
    if (!composerShown || freshStarts === handledFreshStart.current) return;
    handledFreshStart.current = freshStarts;
    // The recovery reply and the snapshot that mounts the box can arrive in
    // either order. Moving elsewhere while recovery runs keeps focus there.
    if (document.activeElement === document.body) messageBox.current?.focus();
  }, [composerShown, freshStarts]);
  const { quotes, remove: removeQuote } = useQuotes(id);
  // A quote added from elsewhere puts the person in the box after it.
  const quoteCount = useRef(quotes.length);
  useEffect(() => {
    if (quotes.length > quoteCount.current) messageBox.current?.focus();
    quoteCount.current = quotes.length;
  }, [quotes.length]);
  const folder = chat.folder;
  const mentions = useMemo<ComposerMentions>(
    () => ({
      records: (query) => client.searchRecords(query),
      linked: chat.links,
      ...(!folder.missing && {
        folder: {
          name: folder.name,
          files: (query: string) => client.folderFiles(folder.path, query),
        },
      }),
      commands: chat.commands,
      harness,
    }),
    [
      client,
      chat.links,
      chat.commands,
      folder.missing,
      folder.name,
      folder.path,
      harness,
    ],
  );
  /** Remounts the composer with the draft after Edit moved a queued message into it. */
  const [edits, setEdits] = useState(0);
  const pending = items.filter(
    (item): item is PendingRequest =>
      item.kind === "request" && item.state === "pending",
  );
  const [answered, setAnswered] = useState<{
    id: string;
    origin: Element | null;
  } | null>(null);
  const handledAnswer = useRef<typeof answered>(null);
  useEffect(() => {
    if (
      !answered ||
      answered === handledAnswer.current ||
      !items.some(
        (item) =>
          item.id === answered.id &&
          item.kind === "request" &&
          item.state === "answered",
      )
    )
      return;
    handledAnswer.current = answered;
    // Only an answer made here returns to triage. Host updates alone never
    // take focus, and moving elsewhere while the answer is sent keeps it there.
    if (
      document.activeElement !== answered.origin &&
      document.activeElement !== document.body
    )
      return;
    if (pending.length) {
      dock.current?.querySelector<HTMLElement>(".chat-request-title")?.focus();
    } else onRequestsAnswered?.();
  }, [answered, items, pending.length, onRequestsAnswered]);
  // Opened from a notification: the request waiting then takes focus, once.
  const [notifiedRequest] = useState(() =>
    focusRequest ? pending[0]?.id : undefined,
  );
  const question = pending.find(
    (item) => item.request === "question" && item.free_text,
  );
  const composerFiles = attachmentsOf(client, id);
  const draftFiles = useSyncExternalStore(
    composerFiles.subscribe,
    composerFiles.snapshot,
  );
  const hasAttachments = draftFiles.length > 0;
  const hasImages = draftFiles.some(
    (file) =>
      file.state === "ready" && file.content.dataUrl.startsWith("data:image/"),
  );
  // A draft typed before a question arrived keeps its meaning: only a box that
  // was empty (or emptied since) answers it.
  const draftHeld = () => (drafts.get(id) ?? "").trim() !== "";
  const [seenQuestion, setSeenQuestion] = useState(question?.id);
  const [heldFor, setHeldFor] = useState(() =>
    question && draftHeld() ? question.id : undefined,
  );
  if (question?.id !== seenQuestion) {
    setSeenQuestion(question?.id);
    setHeldFor(question && draftHeld() ? question.id : undefined);
  }
  const answering =
    Boolean(question) && heldFor !== question?.id && !hasAttachments;
  const stoppable =
    isLive(chat) && !chat.stopping && !unconfirmedStart && chat.has_composer;
  /** Stops the turn; the Stop button leaves, so the message box takes focus. */
  const stop = () => {
    messageBox.current?.focus();
    // A refused change is about the session Stop ends, or the run it takes over.
    setAsked(null);
    quietly(client.stop(id), "stop the turn");
  };
  // When a menu, popover or picker last took an Esc: the next Esc a moment
  // later is the same habit (closing things), not a request to stop.
  const layerClosedAt = useRef(-Infinity);
  useEffect(() => {
    const note = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && document.querySelector(LAYER))
        layerClosedAt.current = performance.now();
    };
    document.addEventListener("keydown", note, true);
    return () => document.removeEventListener("keydown", note, true);
  }, []);
  /**
   * Esc stops the turn only from an empty message box or the transcript, and
   * never just after it closed a menu or popover, or from a request in the dock.
   */
  const onPaneKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    if (event.defaultPrevented || !stoppable || picked) return;
    const target = event.target as Element;
    if (target.closest(LAYER) || document.querySelector(LAYER)) return;
    if (performance.now() - layerClosedAt.current < ESC_AFTER_LAYER_MS) return;
    if (target.closest(".chat-activity")) return;
    if ((messageBox.current?.value ?? "").trim() !== "" || hasAttachments)
      return;
    event.preventDefault();
    stop();
  };
  const answer = (requestId: string, optionId: string) =>
    client.answer(id, requestId, { option_id: optionId }).then(
      () => setFailure(null),
      (reason: unknown) => {
        // The request left the dock; say why the pick did nothing.
        if (reason instanceof ChatError && reason.code === "stale")
          setFailure({
            failure: {
              code: "failed",
              title: "Couldn't apply your answer",
              sentence: "The request had already closed.",
              action: null,
              details: "",
            },
          });
        else throw reason;
        if (onRequestsAnswered) throw reason;
      },
    );
  const savingDraft = (submission: Promise<void>) => {
    draftSubmissions.set(composerFiles, submission);
    return submission;
  };
  const edit = (queuedId: string) =>
    quietly(
      client.editQueued(id, queuedId).then(async ({ text, attachments }) => {
        // A successful submission clears its draft before recovered content is merged.
        await draftSubmissions.get(composerFiles)?.catch(() => {});
        const draft = drafts.get(id) ?? "";
        if (text) {
          const next = draft.trim() ? `${draft}\n\n${text}` : text;
          const tokens = tokensOf(id);
          drafts.set(id, next);
          draftTokens.set(id, { text: next, tokens });
        }
        if (attachments.length) composerFiles.addCaptured(attachments);
        if (question && text) setHeldFor(question.id);
        setEdits((count) => count + 1);
      }),
      "edit the queued message",
    );
  // Placed once when the Chat opens; it stays until the person sends or leaves.
  // After what the person read through, which the host keeps (#365); a Chat
  // never read here says from its unseen turn.
  const [newFrom, setNewFrom] = useState(() => {
    const seen = chat.read_through ?? undefined;
    const after = seen && firstNew(items, seen);
    if (after) return after;
    return chat.unseen ? unseenFrom(items) : undefined;
  });
  // The host keeps the furthest item read; while the person scrolls, one write
  // per pause is enough, and leaving the Chat sends what is still waiting.
  const readThrough = useRef<{ item?: string | undefined; timer?: number }>({});
  useEffect(() => {
    const pending = readThrough.current;
    return () => {
      window.clearTimeout(pending.timer);
      if (pending.item)
        void client.readThrough(id, pending.item).catch(() => {});
      pending.item = undefined;
    };
  }, [client, id]);
  const { root, content, marker, following, reading, follow, onScroll } =
    useTranscriptScroll(id, (itemId) => {
      const pending = readThrough.current;
      pending.item = itemId;
      window.clearTimeout(pending.timer);
      pending.timer = window.setTimeout(() => {
        pending.item = undefined;
        void client.readThrough(id, itemId).catch(() => {});
      }, READ_THROUGH_MS);
    });
  /** Sending resumes following and clears the New marker. */
  const sent = <T,>(action: Promise<T>) => {
    follow();
    setNewFrom(undefined);
    setAsked(null);
    return action;
  };
  const messageCount = items.filter(isMessage).length;
  // Pickers and menus opened in the conversation stay below the pane header.
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const trashed = chat.retention === "trashed";
  const onNotice = (action: Exclude<NoticeAction, "help" | "copy-command">) => {
    if (action === "check") quietly(client.checkAgain(id), "check again");
    else if (action === "start-fresh") {
      // An earlier queue edit's autofocus must expire before the box returns.
      if (!chat.has_composer) setEdits(0);
      void run(client.resume(id, { kind: "none" }), "start a fresh session")
        .then(() => setFreshStarts((count) => count + 1))
        .catch(() => {});
    } else if (action === "resume") setResuming(true);
    else if (action === "pick-folder")
      quietly(
        client
          .pickFolder()
          .then((path) => (path ? client.setFolder(id, path) : undefined)),
        "change the folder",
      );
    else if (chat.problem?.message_id)
      quietly(
        client.resolveUncertain(
          id,
          chat.problem.message_id,
          action === "resend" ? "resend" : "discard",
        ),
        action === "resend" ? "send it again" : "discard it",
      );
  };
  return (
    <OverlayBoundary element={body}>
      <div ref={setBody} className="chat-body" onKeyDown={onPaneKey}>
        {!trashed && !picked && (
          <LinkedRecords
            chat={chat}
            scrolled={scrolled}
            onFailure={setFailure}
          />
        )}
        <div className="chat-reading">
          <ReadingContext value={reading}>
            <div
              ref={root}
              className="chat-scroll"
              tabIndex={0}
              aria-label="Conversation"
              onScroll={(event) => {
                onScroll();
                setScrolled(event.currentTarget.scrollTop > 0);
              }}
            >
              <Transcript
                chat={chat}
                items={items}
                parts={parts}
                actions={actions}
                newFrom={newFrom}
                markerRef={marker}
                contentRef={content}
                picked={picked ?? undefined}
                onPick={(itemId, include) =>
                  setPicked((current) => {
                    const next = new Set(current);
                    if (include) next.add(itemId);
                    else next.delete(itemId);
                    return next;
                  })
                }
              />
            </div>
          </ReadingContext>
          <JumpToLatest
            shown={!following}
            onJump={(fromKeyboard) => {
              follow();
              if (fromKeyboard) messageBox.current?.focus();
            }}
          />
        </div>
        <div className="chat-dock">
          {notice && <p className="chat-line chat-note">{notice}</p>}
          <div className="sr-only" aria-live="polite">
            {pending[0]
              ? requestLabel(pending[0])
              : chat.stopping
                ? "Stopping…"
                : turnStatus(chat, items)}
          </div>
          {changeLine && (
            <p className="chat-fine" role="alert">
              {changeLine}
            </p>
          )}
          {arrival && (
            <p className="chat-fine" role="alert">
              {arrival}
            </p>
          )}
          {failure && (
            <FailureAlert
              size="compact"
              failure={failure.failure}
              {...(failure.retry &&
                (!failure.retryRequiresSend || !chat.problem?.blocks_send) && {
                  onRetry: failure.retry,
                })}
            />
          )}
          {picked ? (
            <div className="chat-line">
              <span>
                Pick the messages to give the new session ·{" "}
                {ofTotal(picked.size, messageCount)}
              </span>
              <span className="chat-spacer" />
              <Button variant="ghost" size="sm" onClick={() => setPicked(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={picked.size === 0}
                onClick={() =>
                  quietly(
                    client
                      .resume(id, { kind: "picked", ids: [...picked] })
                      .then(() => setPicked(null)),
                    "resume the Chat",
                  )
                }
              >
                Resume
              </Button>
            </div>
          ) : trashed ? (
            <p className="chat-line">
              <Trash2 size={14} aria-hidden />
              <span>
                In Trash. It was stopped; its history, queued messages and files
                are kept. Restoring never re-runs anything.
              </span>
            </p>
          ) : !chat.has_composer ? (
            problem && (
              <ProblemNotice
                problem={problem}
                harness={harness}
                onAction={onNotice}
              />
            )
          ) : (
            // One composed tray (CH-22): the problem notice, the request, the
            // plan pill and the queue sit inside the composer's one ring, as
            // sections split by hairlines on one 16px inner edge. The top part
            // glides as one block when something arrives or leaves.
            <div className="chat-tray">
              <DockSlot className="chat-tray-top">
                {problem && (
                  <ProblemNotice
                    flat
                    problem={problem}
                    harness={harness}
                    onAction={onNotice}
                  />
                )}
                <ActivityDock
                  chat={chat}
                  focusRequest={
                    notifiedRequest !== undefined &&
                    pending[0]?.id === notifiedRequest
                  }
                  requests={pending}
                  {...(plan && { plan: <PlanPill item={plan} /> })}
                  dockRef={dock}
                  onAnswer={answer}
                  {...(onRequestsAnswered && {
                    onAnswered: (requestId: string, origin: Element | null) =>
                      setAnswered({ id: requestId, origin }),
                  })}
                  onLeave={() => messageBox.current?.focus()}
                  onSendNow={(queuedId) =>
                    run(
                      client.sendQueuedNow(id, queuedId),
                      "send the queued message",
                    ).then(() => {})
                  }
                  onEdit={edit}
                  onRemove={(queuedId) => {
                    const remove = () => {
                      const origin = document.activeElement;
                      void run(
                        client.removeQueued(id, queuedId),
                        "remove the queued message",
                        remove,
                      )
                        .then(() => {
                          if (
                            document.activeElement === origin ||
                            document.activeElement === document.body
                          )
                            messageBox.current?.focus();
                        })
                        .catch(() => {});
                    };
                    remove();
                  }}
                  onResume={() =>
                    quietly(client.resumeQueue(id), "resume the queue")
                  }
                />
              </DockSlot>
              <Composer
                retryRef={retrySend}
                key={`${id}:${edits}`}
                framed={false}
                inputRef={messageBox}
                autoFocus={edits > 0}
                placeholder={composerPlaceholder(chat, answering, hasImages)}
                initialText={drafts.get(id) ?? ""}
                initialTokens={tokensOf(id)}
                attachments={composerFiles}
                onText={(text, tokens) => {
                  drafts.set(id, text);
                  draftTokens.set(id, { text, tokens });
                  if (!text.trim()) setHeldFor(undefined);
                  else if (hasAttachments && question) setHeldFor(question.id);
                }}
                mentions={mentions}
                above={
                  <ComposerQuotes quotes={quotes} onRemove={removeQuote} />
                }
                controls={(text, hasAttachments) =>
                  composerControls(
                    chat,
                    text,
                    answering,
                    hasAttachments,
                    hasImages,
                  )
                }
                onSend={(text, links, attachments) => {
                  const answerQuestion =
                    answering && question && !attachments?.length;
                  const outgoingText = quotedMessage(quotes, text);
                  const outgoingLinks = [...links, ...quoteLinks(quotes)];
                  const submission = run(
                    sent(
                      answerQuestion
                        ? client.answer(id, question.id, { text })
                        : (attachments
                            ? client.send(
                                id,
                                outgoingText,
                                outgoingLinks,
                                attachments,
                              )
                            : client.send(id, outgoingText, outgoingLinks)
                          ).then(() => clearQuotes(id)),
                    ),
                    answerQuestion ? "send your answer" : "send the message",
                    answerQuestion
                      ? undefined
                      : () => {
                          messageBox.current?.focus();
                          retrySend.current?.();
                        },
                    true,
                  );
                  return savingDraft(submission);
                }}
                onQueue={(text, links, attachments) => {
                  const outgoingText = quotedMessage(quotes, text);
                  const outgoingLinks = [...links, ...quoteLinks(quotes)];
                  const queued = attachments
                    ? client.queue(id, outgoingText, outgoingLinks, attachments)
                    : client.queue(id, outgoingText, outgoingLinks);
                  const submission = run(
                    sent(queued.then(() => clearQuotes(id))),
                    "queue the message",
                    () => {
                      messageBox.current?.focus();
                      retrySend.current?.();
                    },
                  );
                  return savingDraft(submission);
                }}
                {...(pending.length > 0 &&
                  !hasAttachments && {
                    onArrowUpFromEmpty: () => focusFirstChoice(dock.current),
                  })}
                {...(isLive(chat) && { onStop: stop })}
                stopping={chat.stopping || unconfirmedStart}
                leading={
                  <ComposerControls
                    chat={chat}
                    inputRef={messageBox}
                    onChange={(setting, value) =>
                      void client.changeSetting(id, setting, value).then(
                        (outcome) => {
                          setFailure(null);
                          setAsked({
                            setting,
                            outcome,
                            label: labelOf(chat.settings?.[setting], value),
                          });
                        },
                        (reason: unknown) =>
                          setFailure(chatFailure(reason, "change the setting")),
                      )
                    }
                  />
                }
                {...(chat.context && {
                  beforeStop: (
                    <ContextCount
                      chat={chat}
                      context={chat.context}
                      asOf={turnStartedAt}
                      returnTo={messageBox}
                    />
                  ),
                })}
              />
            </div>
          )}
        </div>
        <ResumeDialog
          open={resuming}
          onOpenChange={setResuming}
          harness={harness}
          messageCount={messageCount}
          onResume={(history) => client.resume(id, history)}
          onPickMessages={() => setPicked(new Set())}
        />
        {saving && (
          <SaveDocumentDialog
            response={saving}
            plan={saving.plan ?? false}
            onClose={() => setSaving(null)}
            onSave={async (responseId, title) => {
              const document = await client.saveAsDocument(
                id,
                responseId,
                title,
              );
              statusLine.show({
                message: `Saved “${title}” to Documents`,
                ...(openDocument && {
                  action: {
                    label: "Open",
                    run: () => openDocument(document, `Back to ${chat.title}`),
                  },
                }),
              });
            }}
          />
        )}
      </div>
    </OverlayBoundary>
  );
}

/** One open Chat: its header, linked records, conversation and composer. */
export function ChatDetail({
  id,
  expanded,
  single,
  onExpand,
  onReturn,
  onClose,
  notice,
  crumb,
  focusRequest = false,
  onRequestsAnswered,
  title,
}: {
  id: string;
  /** The title to show until the Chat is read, when the opener knows it. */
  title?: string | undefined;
  /** What ticketd says above the composer about this Chat, where it is open. */
  notice?: ReactNode;
  /** The person asked for the full width. */
  expanded: boolean;
  /** The list is not beside this pane (expanded, or the window is narrow). */
  single: boolean;
  onExpand: () => void;
  onReturn: () => void;
  onClose: () => void;
  /** Back to where the Chat was opened from, such as its ticket. */
  crumb?: ReactNode;
  /** Opened from a notification: a pending request's title takes focus once shown. */
  focusRequest?: boolean;
  /** Inbox triage resumes after this view answers its final pending request. */
  onRequestsAnswered?: () => void;
}) {
  const client = useChatClient();
  const { snapshot, error, retry } = useChat(id);
  const [failure, setFailure] = useState<ChatFailureNotice | null>(null);
  const [linking, setLinking] = useState(false);
  const chat = snapshot?.chat;
  const retain = (name: string, action: () => Promise<void>): void =>
    void action().then(
      () => setFailure(null),
      (reason: unknown) =>
        setFailure(chatFailure(reason, name, () => retain(name, action))),
    );
  return (
    <section
      className="ticket-detail chat-pane"
      aria-labelledby="chat-heading"
      data-expanded={expanded ? "" : undefined}
    >
      <div className="detail-header">
        <div className="detail-title-group">
          {crumb}
          {!crumb && single && !expanded && (
            <IconButton label="Back to Chats" onClick={onReturn}>
              <ArrowLeft aria-hidden />
            </IconButton>
          )}
          {chat && (
            <HarnessMark
              harness={chat.harness.id}
              name={chat.harness.name}
              className="chat-head-mark"
            />
          )}
          <h2 id="chat-heading" className="chat-head-title" tabIndex={-1}>
            {chat?.title ?? (title || "Chat")}
          </h2>
          {chat && (
            <ChatContext chat={chat} asOf={lastAsk(snapshot?.items ?? [])} />
          )}
        </div>
        <div className="detail-actions">
          {/* Bringing a Chat back is the pane's one primary, archived or
              trashed alike (CH-07). */}
          {chat?.retention === "archived" && (
            <Button
              size="sm"
              onClick={() =>
                retain("unarchive the Chat", () => client.unarchive(id))
              }
            >
              Unarchive
            </Button>
          )}
          {chat?.retention === "trashed" && (
            <Button
              size="sm"
              onClick={() =>
                retain("restore the Chat", () => client.restore(id))
              }
            >
              Restore
            </Button>
          )}
          {chat && chat.retention !== "trashed" && (
            <>
              <ChatActionsMenu
                chat={chat}
                label="Chat actions"
                onResult={setFailure}
                onLink={() => setLinking(true)}
              />
              <LinkPicker
                linked={chat.links}
                anchorClassName="chat-link-anchor"
                open={linking}
                onOpenChange={setLinking}
                onPick={(record) =>
                  retain(`link ${record.title}`, () =>
                    client.addLink(id, { kind: record.kind, id: record.id }),
                  )
                }
              />
            </>
          )}
          {expanded ? (
            <IconButton label="Show beside the list" onClick={onReturn}>
              <Minimize2 aria-hidden />
            </IconButton>
          ) : (
            !single && (
              <IconButton label="Expand Chat" onClick={onExpand}>
                <Maximize2 aria-hidden />
              </IconButton>
            )
          )}
          <IconButton label="Close Chat" onClick={onClose}>
            <X aria-hidden />
          </IconButton>
        </div>
        {failure && (
          <FailureAlert
            size="compact"
            failure={failure.failure}
            {...(failure.retry && { onRetry: failure.retry })}
          />
        )}
      </div>
      {error && !snapshot && <FailureState failure={error} onRetry={retry} />}
      {!snapshot && !error && (
        <p className="chat-list-empty" role="status">
          Opening the Chat…
        </p>
      )}
      {snapshot && (
        <Conversation
          key={id}
          snapshot={snapshot}
          focusRequest={focusRequest}
          {...(onRequestsAnswered && { onRequestsAnswered })}
          notice={notice}
        />
      )}
    </section>
  );
}
