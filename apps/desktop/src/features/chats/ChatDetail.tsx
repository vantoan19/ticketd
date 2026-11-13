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
import { IconButton } from "@/components/ui/icon-button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useCopy } from "@/components/ui/use-copy";
import { workspaceClient } from "@/lib/api/workspace";
import { PathText } from "@/features/projects/PathText";
import { withoutVerbatim } from "@/features/projects/paths";
import { ActivityDock } from "@/features/chats/ActivityDock";
import { focusLastChoice } from "@/features/chats/dock-focus";
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
import { ChatContext } from "@/features/chats/ChatContext";
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
import { runningPlan } from "@/features/chats/reports";
import { ContextRing, PlanPill } from "@/features/chats/TurnReports";
import { LinkPicker, RecordChip } from "@/features/chats/LinkPicker";
import {
  composerControls,
  composerPlaceholder,
  firstNew,
  unseenFrom,
  hasComposer,
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
  lastSeen,
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
          <PathText path={path} />
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
  "pick-folder": "Pick another folder…",
  resume: "Resume in a fresh session…",
};

/** The one notice above the composer: what is wrong and what the person can do. */
export function ProblemNotice({
  problem,
  harness,
  onAction,
}: {
  problem: Problem;
  harness: string;
  onAction: (action: Exclude<NoticeAction, "help" | "copy-command">) => void;
}) {
  const notice = problemNotice(
    problem.path
      ? { ...problem, path: withoutVerbatim(problem.path) }
      : problem,
    harness,
  );
  const { copied, error, copy } = useCopy();
  return (
    <Alert tone={notice.tone}>
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
  onFailure: (failure: string) => void;
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
  const settle = (action: Promise<void>) =>
    void action.then(
      () => onFailure(""),
      (reason: unknown) =>
        onFailure(reason instanceof Error ? reason.message : String(reason)),
    );
  const remove = (record: LinkedRecord) =>
    settle(client.removeLink(chat.id, { kind: record.kind, id: record.id }));
  const add = (record: LinkedRecord) =>
    settle(client.addLink(chat.id, { kind: record.kind, id: record.id }));
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

function Conversation({ snapshot }: { snapshot: ChatSnapshot }) {
  const client = useChatClient();
  const { chat, items } = snapshot;
  const id = chat.id;
  const harness = chat.harness.name;
  const [failure, setFailure] = useState(() => arrivals.get(id) ?? "");
  // Said once: the next time this Chat opens it starts without the reason.
  useEffect(() => void arrivals.delete(id), [id]);
  const [resuming, setResuming] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
  const [saving, setSaving] = useState<{
    id: string;
    text: string;
    plan?: boolean;
  } | null>(null);
  const [saved, setSaved] = useState("");
  /** A model, effort or permission change asked for here, until the next send. */
  const [asked, setAsked] = useState<AskedChange | null>(null);
  const changeLine = settingLine(chat, asked);
  /** Runs a command; a refusal is said once, and the view keeps the host's state. */
  const run = (action: Promise<unknown>) =>
    action.then(
      () => setFailure(""),
      (reason: unknown) => {
        setFailure(reason instanceof Error ? reason.message : String(reason));
        throw reason;
      },
    );
  const quietly = (action: Promise<unknown>) =>
    void run(action).catch(() => {});
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
  const plan = runningPlan(items);
  const turnStartedAt = [...items]
    .reverse()
    .find((item) => item.kind === "user")?.at;
  const messageBox = useRef<HTMLTextAreaElement>(null);
  const dock = useRef<HTMLDivElement>(null);
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
      harness,
    }),
    [client, chat.links, folder.missing, folder.name, folder.path, harness],
  );
  /** Remounts the composer with the draft after Edit moved a queued message into it. */
  const [edits, setEdits] = useState(0);
  const pending = items.filter(
    (item): item is PendingRequest =>
      item.kind === "request" && item.state === "pending",
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
  const stoppable = isLive(chat) && !chat.stopping && hasComposer(chat);
  const stop = () => quietly(client.stop(id));
  /** Esc stops the turn, unless a menu, dialog or picker is open to take it first. */
  const onPaneKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    if (event.defaultPrevented || !stoppable || picked) return;
    const layer =
      '[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"]';
    if (
      (event.target as Element).closest(layer) ||
      document.querySelector(layer)
    )
      return;
    event.preventDefault();
    stop();
  };
  const answer = (requestId: string, optionId: string) =>
    client.answer(id, requestId, { option_id: optionId }).then(
      () => setFailure(""),
      (reason: unknown) => {
        // The request left the dock; say why the pick did nothing.
        if (reason instanceof ChatError && reason.code === "stale")
          setFailure("The request had closed; your answer wasn't applied.");
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
    );
  // Placed once when the Chat opens; it stays until the person sends or leaves.
  // Without a seen position from this session, the host's own (#365) says
  // whether the last ended turn is unseen.
  const [newFrom, setNewFrom] = useState(() => {
    const seen = lastSeen(id);
    if (seen) return firstNew(items, seen);
    return chat.unseen ? unseenFrom(items) : undefined;
  });
  const { root, content, marker, following, reading, follow, onScroll } =
    useTranscriptScroll(id);
  /** Sending resumes following and clears the New marker. */
  const sent = <T,>(action: Promise<T>) => {
    follow();
    setNewFrom(undefined);
    setAsked(null);
    return action;
  };
  const messageCount = items.filter(isMessage).length;
  const trashed = chat.retention === "trashed";
  const onNotice = (action: Exclude<NoticeAction, "help" | "copy-command">) => {
    if (action === "check") quietly(client.checkAgain(id));
    else if (action === "resume") setResuming(true);
    else if (action === "pick-folder")
      quietly(
        client
          .pickFolder()
          .then((path) => (path ? client.setFolder(id, path) : undefined)),
      );
    else if (chat.problem?.message_id)
      quietly(
        client.resolveUncertain(
          id,
          chat.problem.message_id,
          action === "resend" ? "resend" : "discard",
        ),
      );
  };
  return (
    <div className="chat-body" onKeyDown={onPaneKey}>
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
        {failure && (
          <p className="chat-fine" role="alert">
            {failure}
          </p>
        )}
        {saved && (
          <p className="chat-fine" role="status">
            Saved “{saved}” to Documents.
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
        ) : (
          <>
            {chat.problem && (
              <ProblemNotice
                problem={chat.problem}
                harness={harness}
                onAction={onNotice}
              />
            )}
            {hasComposer(chat) && (
              <div className="chat-seat">
                <ActivityDock
                  chat={chat}
                  requests={pending}
                  {...(plan && { plan: <PlanPill item={plan} /> })}
                  dockRef={dock}
                  onAnswer={answer}
                  onLeave={() => messageBox.current?.focus()}
                  onSendNow={(queuedId) =>
                    run(client.sendQueuedNow(id, queuedId)).then(() => {})
                  }
                  onEdit={edit}
                  onRemove={(queuedId) =>
                    quietly(client.removeQueued(id, queuedId))
                  }
                  onResume={() => quietly(client.resumeQueue(id))}
                />
                <Composer
                  key={`${id}:${edits}`}
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
                    )
                  }
                  {...(pending.length > 0 && {
                    onArrowUpFromEmpty: () => focusLastChoice(dock.current),
                  })}
                  {...(isLive(chat) && { onStop: stop })}
                  stopping={chat.stopping}
                  leading={
                    <ComposerControls
                      chat={chat}
                      inputRef={messageBox}
                      onChange={(setting, value) =>
                        void client.changeSetting(id, setting, value).then(
                          (outcome) => {
                            setFailure("");
                            setAsked({ setting, outcome });
                          },
                          (reason: unknown) =>
                            setFailure(
                              reason instanceof Error
                                ? reason.message
                                : String(reason),
                            ),
                        )
                      }
                    />
                  }
                  {...(chat.context && {
                    beforeStop: (
                      <ContextRing
                        context={chat.context}
                        turnStartedAt={turnStartedAt}
                      />
                    ),
                  })}
                />
              </div>
            )}
          </>
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
            setSaved(title);
          }}
        />
      )}
    </div>
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
}) {
  const client = useChatClient();
  const { snapshot, error } = useChat(id);
  const [failure, setFailure] = useState("");
  const [linking, setLinking] = useState(false);
  const chat = snapshot?.chat;
  const retain = (action: Promise<void>) =>
    void action.then(
      () => setFailure(""),
      (reason: unknown) => setFailure(String(reason)),
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
          {!crumb && single && (
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
          {chat && <ChatContext chat={chat} />}
        </div>
        <div className="detail-actions">
          {chat?.retention === "archived" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => retain(client.unarchive(id))}
            >
              Unarchive
            </Button>
          )}
          {chat?.retention === "trashed" && (
            <Button size="sm" onClick={() => retain(client.restore(id))}>
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
                open={linking}
                onOpenChange={setLinking}
                onPick={(record) =>
                  retain(
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
        {(failure || error) && (
          <p className="detail-header-message" role="alert">
            {failure || `Could not open this Chat: ${error}`}
          </p>
        )}
      </div>
      {snapshot && <Conversation key={id} snapshot={snapshot} />}
    </section>
  );
}
