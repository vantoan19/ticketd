import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
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
  settingLine,
  type AskedChange,
} from "@/features/chats/composer-settings";
import { HarnessMark } from "@/features/chats/HarnessMark";
import { Composer } from "@/features/chats/Composer";
import type { ComposerMentions } from "@/features/chats/ComposerField";
import { ComposerQuotes } from "@/features/chats/ComposerQuote";
import {
  arrivals,
  drafts,
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
  turnStatus,
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
  onFailure,
}: {
  chat: ChatState;
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
    <div className="chat-linked">
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
/** How long "Saved to Documents." stays, as the Documents Undo note does. */
const SAVED_NOTE_MS = 10_000;

function Conversation({
  snapshot,
  focusRequest,
}: {
  snapshot: ChatSnapshot;
  focusRequest: boolean;
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
  /**
   * Counts saves as a Document; nonzero while the confirmation shows. It clears
   * on the next send or after a while, so it never goes stale (CH-33).
   */
  const [saved, setSaved] = useState(0);
  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(0), SAVED_NOTE_MS);
    return () => window.clearTimeout(timer);
  }, [saved]);
  /** A model, effort or permission change asked for here, until the next send. */
  const [asked, setAsked] = useState<AskedChange | null>(null);
  const changeLine = settingLine(reported, asked);
  /**
   * Runs a command; a refusal is said once, and the view keeps the host's
   * state. `name` says what did not happen: "send the message".
   */
  const run = (action: Promise<unknown>, name: string) =>
    action.then(
      () => {
        setFailure(null);
        setArrival("");
      },
      (reason: unknown) => {
        setFailure(chatFailure(reason, name));
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
    }),
    [client, id],
  );
  // A message just sent shows its turn starting at once (LIVE-6).
  const chat = asStarting(reported, items);
  /** Running only in this view so far: Stop waits for the host to know of the turn. */
  const unconfirmedStart = chat !== reported;
  const plan = runningPlan(items);
  const turnStartedAt = lastAsk(items);
  const messageBox = useRef<HTMLTextAreaElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  // Opening a Chat whose opener left (a list row re-sorted, a pane swapped)
  // must not strand the keyboard on the page: the message box takes it.
  useEffect(() => {
    if (document.activeElement === document.body) messageBox.current?.focus();
  }, []);
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
  // Opened from a notification: the request waiting then takes focus, once.
  const [notifiedRequest] = useState(() =>
    focusRequest ? pending[0]?.id : undefined,
  );
  const question = pending.find(
    (item) => item.request === "question" && item.free_text,
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
  const answering = Boolean(question) && heldFor !== question?.id;
  const stoppable =
    isLive(chat) && !chat.stopping && !unconfirmedStart && chat.has_composer;
  /** Stops the turn; the Stop button leaves, so the message box takes focus. */
  const stop = () => {
    messageBox.current?.focus();
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
    if ((messageBox.current?.value ?? "").trim() !== "") return;
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
      },
    );
  const edit = (queued: { id: string; text: string }) =>
    quietly(
      client.removeQueued(id, queued.id).then(() => {
        const draft = drafts.get(id) ?? "";
        drafts.set(
          id,
          draft.trim() ? `${draft}\n\n${queued.text}` : queued.text,
        );
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
  const { root, content, marker, following, reading, follow, onScroll } =
    useTranscriptScroll(
      id,
      (itemId) => void client.readThrough(id, itemId).catch(() => {}),
    );
  /** Sending resumes following and clears the New marker. */
  const sent = <T,>(action: Promise<T>) => {
    follow();
    setNewFrom(undefined);
    setAsked(null);
    setSaved(0);
    return action;
  };
  const messageCount = items.filter(isMessage).length;
  // Pickers and menus opened in the conversation stay below the pane header.
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const trashed = chat.retention === "trashed";
  const onNotice = (action: Exclude<NoticeAction, "help" | "copy-command">) => {
    if (action === "check") quietly(client.checkAgain(id), "check again");
    else if (action === "resume") setResuming(true);
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
          <LinkedRecords chat={chat} onFailure={setFailure} />
        )}
        <div className="chat-reading">
          <ReadingContext value={reading}>
            <div
              ref={root}
              className="chat-scroll"
              tabIndex={0}
              aria-label="Conversation"
              onScroll={onScroll}
            >
              <Transcript
                chat={chat}
                items={items}
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
              {...(failure.retry && { onRetry: failure.retry })}
            />
          )}
          {saved > 0 && (
            <p className="chat-fine" role="status">
              Saved to Documents.
            </p>
          )}
          {picked ? (
            <div className="chat-line">
              <span>
                {picked.size} of {messageCount} messages picked
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
            chat.problem && (
              <ProblemNotice
                problem={chat.problem}
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
                {chat.problem && (
                  <ProblemNotice
                    flat
                    problem={chat.problem}
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
                  onLeave={() => messageBox.current?.focus()}
                  onSendNow={(queuedId) =>
                    run(
                      client.sendQueuedNow(id, queuedId),
                      "send the queued message",
                    ).then(() => {})
                  }
                  onEdit={edit}
                  onRemove={(queuedId) =>
                    quietly(
                      client.removeQueued(id, queuedId),
                      "remove the queued message",
                    )
                  }
                  onResume={() =>
                    quietly(client.resumeQueue(id), "resume the queue")
                  }
                />
              </DockSlot>
              <Composer
                key={`${id}:${edits}`}
                framed={false}
                inputRef={messageBox}
                autoFocus={edits > 0}
                placeholder={composerPlaceholder(chat, answering)}
                initialText={drafts.get(id) ?? ""}
                initialTokens={tokensOf(id)}
                onText={(text, tokens) => {
                  drafts.set(id, text);
                  draftTokens.set(id, { text, tokens });
                  if (!text.trim()) setHeldFor(undefined);
                }}
                mentions={mentions}
                above={
                  <ComposerQuotes quotes={quotes} onRemove={removeQuote} />
                }
                controls={(text) => composerControls(chat, text, answering)}
                onSend={(text, links) =>
                  run(
                    sent(
                      answering && question
                        ? client.answer(id, question.id, { text })
                        : client
                            .send(id, quotedMessage(quotes, text), [
                              ...links,
                              ...quoteLinks(quotes),
                            ])
                            .then(() => clearQuotes(id)),
                    ),
                    answering && question
                      ? "send your answer"
                      : "send the message",
                  )
                }
                onQueue={(text, links) =>
                  run(
                    sent(
                      client
                        .queue(id, quotedMessage(quotes, text), [
                          ...links,
                          ...quoteLinks(quotes),
                        ])
                        .then(() => clearQuotes(id)),
                    ),
                    "queue the message",
                  )
                }
                {...(pending.length > 0 && {
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
                          setAsked({ setting, outcome });
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
              await client.saveAsDocument(id, responseId, title);
              setSaved((count) => count + 1);
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
  crumb,
  focusRequest = false,
}: {
  id: string;
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
            {chat?.title ?? "Chat"}
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
      {snapshot && (
        <Conversation
          key={id}
          snapshot={snapshot}
          focusRequest={focusRequest}
        />
      )}
    </section>
  );
}
