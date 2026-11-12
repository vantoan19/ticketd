import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronDown,
  Clock,
  Ellipsis,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import {
  useChatClient,
  type ChatSnapshot,
  type ChatState,
  type Problem,
  type TranscriptItem,
} from "@/features/chats/client";
import { Composer } from "@/features/chats/Composer";
import { arrivals, drafts } from "@/features/chats/drafts";
import { ResumeDialog, SaveDocumentDialog } from "@/features/chats/dialogs";
import { LinkPicker, RecordChip } from "@/features/chats/LinkPicker";
import {
  composerControls,
  hasComposer,
  isLive,
  problemNotice,
  type NoticeAction,
} from "@/features/chats/model";
import {
  Transcript,
  type TranscriptActions,
} from "@/features/chats/Transcript";
import { useChat } from "@/features/chats/use-chats";

/**
 * Sets `code spans` of a notice's sentence in mono. A span that is `path` reads
 * as paths do elsewhere: one line, shortened in the middle.
 */
function NoticeText({ text, path }: { text: string; path?: string }) {
  return text.split("`").map((part, index) =>
    index % 2 ? (
      path && part === withoutVerbatim(path) ? (
        <PathText key={index} path={path} />
      ) : (
        <code key={index} className="chat-mono">
          {part}
        </code>
      )
    ) : (
      part
    ),
  );
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

function HarnessAndFolder({ chat }: { chat: ChatState }) {
  // A managed folder is named by an id; it reads as the folder ticketd keeps,
  // as New Chat calls it.
  const folder = chat.folder.managed ? "ticketd folder" : chat.folder.name;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className="min-w-0 shrink"
          aria-label="Harness and folder"
        >
          <span className="truncate">
            {chat.harness.name} · {folder}
            {chat.folder.missing && " (missing)"}
          </span>
          <ChevronDown aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-75"
        aria-label="Harness and folder"
      >
        <div className="chat-pop">
          <section>
            <h3>Harness</h3>
            <p>{chat.harness.name}</p>
            {chat.harness.permissions && (
              <small>{chat.harness.permissions}</small>
            )}
          </section>
          <section>
            <h3>Folder</h3>
            <PathText path={chat.folder.path} />
            {chat.folder.missing && <small>Not found on this computer</small>}
            {chat.folder.managed && (
              <small>Kept by ticketd for this Chat</small>
            )}
            {chat.folder.shared_with.length > 0 && (
              <small>Also used by {chat.folder.shared_with.join(", ")}</small>
            )}
          </section>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function LinkedRecords({ chat }: { chat: ChatState }) {
  const client = useChatClient();
  return (
    <div className="chat-linked">
      <div role="group" aria-label="Linked records">
        {chat.links.map((record) => (
          <RecordChip
            key={`${record.kind}:${record.id}`}
            record={record}
            backLabel={`Back to ${chat.title}`}
            onRemove={() =>
              void client
                .removeLink(chat.id, { kind: record.kind, id: record.id })
                .catch(() => {})
            }
          />
        ))}
        <LinkPicker
          linked={chat.links}
          onPick={(record) =>
            void client
              .addLink(chat.id, { kind: record.kind, id: record.id })
              .catch(() => {})
          }
        />
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
  const [saving, setSaving] = useState<{ id: string; text: string } | null>(
    null,
  );
  const [saved, setSaved] = useState("");
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
      answer: (requestId, answer) =>
        void client.answer(id, requestId, answer).then(
          () => setFailure(""),
          (reason: unknown) =>
            setFailure(
              reason instanceof Error ? reason.message : String(reason),
            ),
        ),
      saveAsDocument: (response) =>
        setSaving({ id: response.id, text: response.text }),
    }),
    [client, id],
  );
  const question = items
    .filter(
      (item) =>
        item.kind === "request" &&
        item.state === "pending" &&
        item.request === "question" &&
        item.free_text,
    )
    .at(-1);
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
    <div className="chat-body">
      {!trashed && !picked && <LinkedRecords chat={chat} />}
      <div className="chat-scroll" tabIndex={0} aria-label="Conversation">
        <Transcript
          chat={chat}
          items={items}
          actions={actions}
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
      <div className="chat-dock">
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
            {chat.queue.length > 0 && (
              <ul className="chat-queue" aria-label="Queued messages">
                {chat.queue.map((queued) => (
                  <li key={queued.id} className="chat-queued">
                    <Clock size={14} aria-hidden />
                    <span>{queued.text}</span>
                    <IconButton
                      label="Remove queued message"
                      onClick={() =>
                        quietly(client.removeQueued(id, queued.id))
                      }
                    >
                      <X aria-hidden />
                    </IconButton>
                  </li>
                ))}
              </ul>
            )}
            {chat.queue_paused && chat.queue.length > 0 && (
              <div className="chat-line">
                <span>Queue paused. Nothing sends until you resume.</span>
                <span className="chat-spacer" />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => quietly(client.resumeQueue(id))}
                >
                  Resume
                </Button>
              </div>
            )}
            {hasComposer(chat) && (
              <Composer
                key={id}
                placeholder={
                  question ? `Answer ${harness}` : `Message ${harness}`
                }
                initialText={drafts.get(id) ?? ""}
                onText={(text) => drafts.set(id, text)}
                controls={(text) =>
                  question && text.trim()
                    ? { kind: "send", enabled: true }
                    : composerControls(chat, text)
                }
                onSend={(text) =>
                  run(
                    question
                      ? client.answer(id, question.id, { text })
                      : client.send(id, text),
                  )
                }
                onQueue={(text) => run(client.queue(id, text))}
                {...(isLive(chat) && {
                  onStop: () => quietly(client.stop(id)),
                })}
              />
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
}: {
  id: string;
  /** The person asked for the full width. */
  expanded: boolean;
  /** The list is not beside this pane (expanded, or the window is narrow). */
  single: boolean;
  onExpand: () => void;
  onReturn: () => void;
  onClose: () => void;
}) {
  const client = useChatClient();
  const { snapshot, error } = useChat(id);
  const [failure, setFailure] = useState("");
  const chat = snapshot?.chat;
  const retain = (action: Promise<void>) =>
    void action.then(
      () => setFailure(""),
      (reason: unknown) => setFailure(String(reason)),
    );
  return (
    <section className="ticket-detail chat-pane" aria-labelledby="chat-heading">
      <div className="detail-header">
        <div className="detail-title-group">
          {single && (
            <IconButton label="Back to Chats" onClick={onReturn}>
              <ArrowLeft aria-hidden />
            </IconButton>
          )}
          <h2 id="chat-heading" className="chat-head-title" tabIndex={-1}>
            {chat?.title ?? "Chat"}
          </h2>
          {chat && <HarnessAndFolder chat={chat} />}
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label="Chat actions">
                  <Ellipsis aria-hidden />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {chat.retention === "active" && (
                  <DropdownMenuItem onSelect={() => retain(client.archive(id))}>
                    Archive
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => retain(client.trash(id))}>
                  Move to Trash
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
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
