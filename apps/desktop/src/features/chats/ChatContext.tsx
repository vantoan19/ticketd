import {
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Folder,
  FolderX,
  GitBranch,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { StatusDot } from "@/components/ui/status-dot";
import { useCopy } from "@/components/ui/use-copy";
import { fileManagerName } from "@/lib/platform";
import { PathText } from "@/components/ui/path-text";
import { ProjectIcon } from "@/features/projects/ProjectIcon";
import {
  useChatClient,
  type ChatClient,
  type ChatState,
  type ContextUsage,
  type HarnessStatus,
} from "@/features/chats/client";
import { HarnessMark } from "@/features/chats/HarnessMark";
import { useChatFeature } from "@/features/chats/use-chats";
import { ProjectNavigation } from "@/features/documents/navigation";
import { contextLabel, folderLabel } from "@/features/chats/model";
import {
  clockTime,
  contextWords,
  preciseTokens,
  tokens,
} from "@/features/chats/reports";

/** A check that has not answered by then reads as "Couldn't check". */
const CHECK_TIMEOUT_MS = 8_000;

/**
 * The last answer per harness, per client: reopening the popover shows it while
 * the check runs again, instead of "Checking…" every time.
 */
const lastChecks = new WeakMap<ChatClient, Map<string, HarnessStatus | null>>();
function checksOf(client: ChatClient) {
  let checks = lastChecks.get(client);
  if (!checks) {
    checks = new Map();
    lastChecks.set(client, checks);
  }
  return checks;
}

/** The folder's Project icon, else the folder; a missing folder says so. */
function FolderLead({ chat }: { chat: ChatState }) {
  if (chat.folder.missing) return <FolderX aria-hidden />;
  if (chat.folder.project) return <ProjectIcon project={chat.folder.project} />;
  return <Folder aria-hidden />;
}

function FolderGroup({ chat }: { chat: ChatState }) {
  const { copied, copy } = useCopy();
  const { folder } = chat;
  const branch = folder.branch;
  return (
    <section aria-label="Folder">
      <div className="chat-pop-title">
        <span className="chat-pop-truncate">{folderLabel(folder)}</span>
        <IconButton
          label={copied ? "Copied" : "Copy path"}
          onClick={() => void copy("Path", folder.path)}
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        </IconButton>
      </div>
      {/* A folder ticketd keeps says so; its scratch path means nothing to
          read, and Copy still gives it (LIVE2-6). */}
      {!folder.managed && <PathText path={folder.path} layout="folder" />}
      {branch &&
        (branch.name ? (
          <p className="chat-pop-branch">
            <GitBranch aria-hidden />
            {branch.kind === "detached" && <span>Detached at</span>}
            {/* Right-to-left puts the ellipsis at the start: the end of a
                branch name tells branches apart. */}
            <span className="chat-mono chat-pop-branch-name">
              <bdo dir="ltr">{branch.name}</bdo>
            </span>
          </p>
        ) : (
          <small>Couldn’t read the branch</small>
        ))}
      {folder.missing && <small>Not found on this computer</small>}
      {folder.managed && <small>Kept by ticketd for this Chat</small>}
    </section>
  );
}

function HarnessGroup({ chat }: { chat: ChatState }) {
  const client = useChatClient();
  const id = chat.harness.id;
  const known = checksOf(client);
  // undefined: no answer yet; null: the check failed or never answered.
  const [status, setStatus] = useState<HarnessStatus | null | undefined>(() =>
    known.get(id),
  );
  const [checks, setChecks] = useState(0);
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    let current = true;
    const answer = (found: HarnessStatus | null) => {
      if (!current) return;
      known.set(id, found);
      setStatus(found);
      setChecking(false);
    };
    const timer = setTimeout(() => answer(null), CHECK_TIMEOUT_MS);
    client.harnesses().then(
      (found) => {
        clearTimeout(timer);
        answer(found.find((item) => item.id === id) ?? null);
      },
      // A check that failed says nothing about the sign-in: not "Signed in".
      () => {
        clearTimeout(timer);
        answer(null);
      },
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [client, known, id, checks]);
  const word = status?.word;
  const ready = status != null && !word;
  const found = [status?.version, status?.path].filter(Boolean);
  return (
    <section aria-label="Harness">
      <div className="chat-pop-harness">
        <span className="chat-pop-line">
          <HarnessMark harness={id} name={chat.harness.name} decorative />
          <span className="chat-pop-truncate">{chat.harness.name}</span>
        </span>
        <span className="chat-pop-status" role="status">
          {/* Opening shows the last answer while it checks again; asking
              to check again says it is checking. */}
          {status === undefined || (checking && checks > 0) ? (
            "Checking…"
          ) : status ? (
            <>
              {(!word || word.dot) && (
                <StatusDot tone={word ? "attention" : "positive"} size={6} />
              )}
              {word?.word ?? "Signed in"}
            </>
          ) : (
            "Couldn't check"
          )}
        </span>
      </div>
      {found.length > 0 ? (
        <small className="chat-mono chat-pop-truncate">
          {found.join(" · ")}
        </small>
      ) : (
        // The version line's place while the first check runs, so the
        // popover does not grow when it answers (LIVE2-7).
        status === undefined && (
          <span className="chat-skeleton chat-pop-skeleton-line" aria-hidden />
        )
      )}
      {!ready && status !== undefined && (
        <Button
          variant="ghost"
          size="xs"
          data-recheck=""
          disabled={checking}
          onClick={() => {
            setChecking(true);
            setChecks((count) => count + 1);
          }}
        >
          Check again
        </Button>
      )}
    </section>
  );
}

function ContextGroup({
  context,
  asOf,
  groupRef,
}: {
  context: ContextUsage;
  /** When the turn the person is looking at began; an older report says when it is from. */
  asOf?: string | undefined;
  groupRef?: RefObject<HTMLElement | null> | undefined;
}) {
  const [details, setDetails] = useState(false);
  const detailsId = useId();
  const words = contextWords(context);
  const started = asOf ? new Date(asOf).getTime() : NaN;
  const stale = !Number.isNaN(started) && context.at < started;
  const size = Math.max(context.window, 1);
  const compactsAt =
    context.compacts_at != null && context.compacts_at < context.window
      ? (context.compacts_at / size) * 100
      : null;
  const note = [
    `${words.percent}% used`,
    context.compacted_at != null
      ? `Compacted at ${clockTime(context.compacted_at)}`
      : context.compacts_at != null &&
        `Compacts near ${tokens(context.compacts_at)}`,
    stale && `As of ${clockTime(context.at)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const categories = [...context.categories].sort(
    (a, b) => b.tokens - a.tokens,
  );
  return (
    <section
      ref={groupRef}
      role="group"
      aria-label="Context"
      tabIndex={-1}
      className="chat-pop-context"
      data-full={words.full ? "" : undefined}
    >
      <p className="chat-pop-context-head">
        <span>Context</span>
        <span className="chat-mono">
          {tokens(context.used)} / {tokens(context.window)}
        </span>
      </p>
      <div className="chat-pop-meter" aria-hidden>
        <span
          className="chat-pop-meter-fill"
          style={{ width: `${words.percent}%` }}
        />
        {/* The compaction point only matters once it is near (LIVE2-6). */}
        {compactsAt != null && words.full && (
          <span
            className="chat-pop-meter-tick"
            style={{ left: `${compactsAt}%` }}
          />
        )}
      </div>
      <small className="chat-pop-context-note">
        {words.full && <StatusDot tone="attention" size={6} />}
        {note}
      </small>
      {categories.length > 0 && (
        <>
          <Button
            variant="ghost"
            size="xs"
            data-details=""
            aria-expanded={details}
            aria-controls={detailsId}
            onClick={() => setDetails((open) => !open)}
          >
            Details
            {details ? (
              <ChevronDown aria-hidden />
            ) : (
              <ChevronRight aria-hidden />
            )}
          </Button>
          {details && (
            <ul id={detailsId} className="chat-pop-categories">
              {categories.map((category) => (
                <li key={category.name}>
                  <span className="chat-pop-truncate">{category.name}</span>
                  <span className="chat-mono">
                    {preciseTokens(category.tokens)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function PlacesGroup({ chat }: { chat: ChatState }) {
  const client = useChatClient();
  const { requestChat } = useChatFeature();
  const openProject = useContext(ProjectNavigation);
  const [failure, setFailure] = useState("");
  const [others, setOthers] = useState(false);
  const othersId = useId();
  const { folder } = chat;
  const count = folder.shared_with.length;
  if (folder.missing && count === 0 && !folder.project) return null;
  return (
    <div className="chat-pop-rows">
      {!folder.missing && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            void client.openFolder(chat.id).then(
              () => setFailure(""),
              (reason: unknown) =>
                setFailure(
                  reason instanceof Error ? reason.message : String(reason),
                ),
            )
          }
        >
          Open in {fileManagerName()}
        </Button>
      )}
      {failure && <small role="alert">{failure}</small>}
      {count > 0 && (
        <>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={others}
            aria-controls={othersId}
            onClick={() => setOthers((open) => !open)}
          >
            <span className="chat-pop-truncate">
              {count} other {count === 1 ? "Chat" : "Chats"} here
            </span>
            {others ? (
              <ChevronDown aria-hidden />
            ) : (
              <ChevronRight aria-hidden />
            )}
          </Button>
          {others && (
            <div id={othersId} className="chat-pop-sublist">
              {folder.shared_with.map((other) => (
                <Button
                  key={other.id}
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    requestChat({
                      kind: "open",
                      chatId: other.id,
                      retention: other.retention,
                    })
                  }
                >
                  <span className="chat-pop-truncate">{other.title}</span>
                </Button>
              ))}
            </div>
          )}
        </>
      )}
      {folder.project &&
        (openProject ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Open tickets of ${folder.project.title}`}
            onClick={() => folder.project && openProject(folder.project.id)}
          >
            <ProjectIcon project={folder.project} />
            <span className="chat-pop-truncate">{folder.project.title}</span>
            <span className="chat-pop-aside">Project</span>
            <ChevronRight aria-hidden />
          </Button>
        ) : (
          <p className="chat-pop-line chat-pop-row">
            <ProjectIcon project={folder.project} />
            <span className="chat-pop-truncate">{folder.project.title}</span>
            <span className="chat-pop-aside">Project</span>
          </p>
        ))}
    </div>
  );
}

/**
 * Everything about where a Chat runs, in one popover: the folder (path,
 * branch), the harness and whether it is ready, how full the context window
 * is, then where to go from here.
 */
function ContextPanel({
  chat,
  asOf,
  contextRef,
}: {
  chat: ChatState;
  asOf?: string | undefined;
  contextRef?: RefObject<HTMLElement | null>;
}) {
  return (
    <div className="chat-pop">
      <FolderGroup chat={chat} />
      <HarnessGroup chat={chat} />
      {chat.context && (
        <ContextGroup
          context={chat.context}
          asOf={asOf}
          groupRef={contextRef}
        />
      )}
      <PlacesGroup chat={chat} />
    </div>
  );
}

/**
 * The header's one context button: the Project icon (else a folder) and the
 * folder's name, capped so it can never push into the title or the actions.
 * Everything else is in its popover.
 */
export function ChatContext({
  chat,
  asOf,
}: {
  chat: ChatState;
  asOf?: string | undefined;
}) {
  const { folder } = chat;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          data-context=""
          data-missing={folder.missing ? "" : undefined}
          aria-label={contextLabel(chat)}
          title={folder.path}
        >
          <FolderLead chat={chat} />
          <span className="chat-context-name">{folderLabel(folder)}</span>
          <ChevronDown aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label="Chat context"
        className="w-70"
        // Focus the popover, not its first button: a ring on Copy read as a
        // selected state (LIVE2-6). Tab still reaches every control.
        tabIndex={-1}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
      >
        <ContextPanel chat={chat} asOf={asOf} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * How full the context window is, as a quiet count before Stop ("144k"); from
 * 80% it says the share with the attention dot. It opens the same popover as
 * the header, at its Context group, and closing it returns to the message box.
 */
export function ContextCount({
  chat,
  context,
  asOf,
  returnTo,
}: {
  chat: ChatState;
  context: ContextUsage;
  asOf?: string | undefined;
  returnTo: RefObject<HTMLElement | null>;
}) {
  const words = contextWords(context);
  const group = useRef<HTMLElement | null>(null);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          data-context-count=""
          data-full={words.full ? "" : undefined}
          aria-label={words.label}
          // The message box keeps focus while the popover opens.
          onMouseDown={(event) => event.preventDefault()}
        >
          {words.full ? (
            <>
              <StatusDot tone="attention" size={6} />
              {words.percent}% context
            </>
          ) : (
            tokens(context.used)
          )}
        </Button>
      </PopoverTrigger>
      {/* Said once when the window passes 80%. */}
      <span className="sr-only" role="status">
        {words.full ? `Context window ${words.percent}% full` : ""}
      </span>
      <PopoverContent
        align="end"
        aria-label="Chat context"
        className="w-70"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          group.current?.scrollIntoView?.({ block: "nearest" });
          group.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          const box = returnTo.current;
          if (!box?.isConnected) return;
          event.preventDefault();
          box.focus();
        }}
      >
        <ContextPanel chat={chat} asOf={asOf} contextRef={group} />
      </PopoverContent>
    </Popover>
  );
}
