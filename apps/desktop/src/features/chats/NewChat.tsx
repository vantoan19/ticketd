import { FailureAlert } from "@/components/ui/failure-alert";
import { describeFailure, sentence } from "@/lib/api/describe-failure";
import { chatFailure, type ChatFailureNotice } from "@/features/chats/failure";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Folder,
  Maximize2,
  Minimize2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { OverlayBoundary } from "@/components/ui/overlay-boundary";
import { Tooltip } from "@/components/ui/tooltip";
import {
  useChatClient,
  type HarnessOptions,
  type HarnessStatus,
  type LinkedRecord,
  type Suggestion,
  type ProjectRef,
} from "@/features/chats/client";
import { ProblemNotice } from "@/features/chats/ChatDetail";
import { ProjectIcon } from "@/features/projects/ProjectIcon";
import { Composer } from "@/features/chats/Composer";
import type { Token } from "@/features/chats/composer-mentions";
import type { ComposerMentions } from "@/features/chats/ComposerField";
import { ComposerQuotes } from "@/features/chats/ComposerQuote";
import { arrivals, draftOf } from "@/features/chats/drafts";
import {
  NEW_CHAT,
  clearQuotes,
  quoteLinks,
  quotedMessage,
  useQuotes,
} from "@/features/chats/quotes";
import { ticketPrompt, type TicketStart } from "@/features/chats/ticket-chat";
import { LinkPicker, RecordChip } from "@/features/chats/LinkPicker";
import { suggestionFill } from "@/features/chats/suggestion-fill";
import { Suggestions } from "@/features/chats/Suggestions";
import { NewChatControls } from "@/features/chats/ComposerControls";
import {
  NO_PICK,
  recentFolders,
  rememberFolder,
  rememberHarness,
  rememberPick,
  rememberedHarness,
  rememberedPick,
  rememberStart,
  startPick,
  type Pick,
} from "@/features/chats/harness-pick";
import { notificationClient } from "@/lib/api/notifications";
import { loadPreferences } from "@/lib/preferences";

/** The folder ticketd makes for a Chat when none is chosen. */
const SCRATCH = "Scratch folder";

/** A recent folder: its name, where it is, and a check on the current one. */
function FolderLine({ path, current }: { path: string; current: boolean }) {
  const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
  const parent = path.slice(0, path.lastIndexOf(name)).replace(/[\\/]$/, "");
  return (
    <span className="chat-folder-option">
      <span className="chat-folder-option-line">
        <span>{name}</span>
        {current && <Check aria-hidden />}
      </span>
      <small>{parent || path}</small>
    </span>
  );
}

/**
 * Starts a Chat: a first message, the harness (chosen only here), the folder
 * it works in, and any records to link. A folder is required; a Project or
 * ticket is not.
 */
export function NewChat({
  expanded,
  single,
  onExpand,
  onReturn,
  onClose,
  onCreated,
  start,
  crumb,
  resting = false,
  focusRequest = 0,
}: {
  /**
   * Shown because no Chat is open (U1): nothing to close, and it waits for
   * the person instead of taking focus.
   */
  resting?: boolean;
  /** Rises when New Chat is asked for: the message box takes focus. */
  focusRequest?: number;
  expanded: boolean;
  single: boolean;
  onExpand: () => void;
  onReturn: () => void;
  onClose: () => void;
  onCreated: (id: string) => void;
  /** "Chat about this ticket": the ticket linked, its Project's folder, an unsent prompt. */
  start?: TicketStart;
  /** Back to the ticket New Chat was opened from. */
  crumb?: ReactNode;
}) {
  const client = useChatClient();
  const draft = draftOf(client, NEW_CHAT);
  // A prefill nobody edited is replaced; a draft someone typed is kept, with
  // the ticket's prompt one click away.
  const [prompt] = useState(() => {
    if (!start) return null;
    const next = ticketPrompt(start.ticket);
    const kept = !draft.canPrefill();
    if (!kept) draft.setText(next.text, next.tokens, true);
    return { ...next, kept };
  });
  const { text: typed, saving } = useSyncExternalStore(
    draft.subscribe,
    draft.snapshot,
  );
  const [composerKey, setComposerKey] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [folderMissing, setFolderMissing] = useState(false);
  const [recent] = useState(recentFolders);
  const { quotes, remove: removeQuote } = useQuotes(NEW_CHAT);
  /** null until the first probe answers: seconds, while each harness is asked. */
  const [harnesses, setHarnesses] = useState<HarnessStatus[] | null>(null);
  const [harnessId, setHarnessId] = useState("");
  /** null is the managed folder ticketd keeps for the Chat. */
  const [folder, setFolder] = useState<string | null>(
    () => start?.folder ?? null,
  );
  const [links, setLinks] = useState<LinkedRecord[]>(() =>
    start ? [start.ticket] : [],
  );
  const [failure, setFailure] = useState<ChatFailureNotice | null>(null);
  const [probe, setProbe] = useState(0);
  // Suggestions show only while the box is empty. Choosing one refills the box
  // (remounting the composer with the prompt) and links its records; both are
  // one undo step, kept in `before`.
  const [before, setBefore] = useState<{
    text: string;
    tokens: Token[];
    links: LinkedRecord[];
    prompt: string;
  } | null>(null);
  const [linkedNote, setLinkedNote] = useState("");
  const [refilled, setRefilled] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  // Asked for again while shown: the person is put in the message box.
  const [seenFocus, setSeenFocus] = useState(focusRequest);
  // It also asks the harnesses again, as opening New Chat always did: one may
  // have been installed or signed in to since the pane was first shown.
  if (focusRequest !== seenFocus) {
    setSeenFocus(focusRequest);
    setProbe((count) => count + 1);
  }
  const firstFocus = useRef(focusRequest);
  useEffect(() => {
    if (seenFocus !== firstFocus.current) input.current?.focus();
  }, [seenFocus]);
  // Pickers and menus opened in the body stay below the pane header.
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const box = input.current;
    if (!refilled || !box) return;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }, [refilled]);
  const refill = (text: string, tokens: Token[]) => {
    if (!draft.setText(text, tokens)) return;
    setComposerKey((count) => count + 1);
    setRefilled((count) => count + 1);
  };
  const choose = (suggestion: Suggestion) => {
    if (draft.locked()) return;
    const { prompt: text, links: chosen } = suggestionFill(suggestion);
    const added = chosen.filter(
      (record) =>
        !links.some(
          (item) => item.kind === record.kind && item.id === record.id,
        ),
    );
    const { text: previous, tokens } = draft.snapshot();
    setBefore({ text: previous, tokens, links, prompt: text });
    setLinks([...links, ...added]);
    refill(text, []);
    const names = added.map((record) =>
      record.kind === "ticket" ? record.reference : record.title,
    );
    setLinkedNote(
      names.length === 0
        ? ""
        : names.length <= 3
          ? `Linked ${names.join(", ")}.`
          : `Linked ${names.length} tickets.`,
    );
  };
  const undoChoice = () => {
    if (!before || draft.locked()) return false;
    setLinks(before.links);
    refill(before.text, before.tokens);
    setBefore(null);
    setLinkedNote("");
    return true;
  };
  /**
   * Names a request to the host. It is repeated only when the very same request
   * is sent again after a failure, which then finds what the first try made; any
   * change to the message, harness, folder or links is a new request.
   */
  const retrySend = useRef<(() => void) | null>(null);
  useEffect(() => {
    let current = true;
    client.harnesses().then(
      (found) => current && setHarnesses(found),
      (reason: unknown) =>
        current &&
        setFailure(
          chatFailure(reason, "list the agents", () =>
            setProbe((count) => count + 1),
          ),
        ),
    );
    return () => {
      current = false;
    };
  }, [client, probe]);
  // The folder's Project, for its icon on the folder button.
  const [projectOf, setProjectOf] = useState<{
    folder: string;
    project: ProjectRef | null;
  } | null>(null);
  useEffect(() => {
    if (!folder) return;
    let current = true;
    client.folderProject(folder).then(
      (project) => current && setProjectOf({ folder, project }),
      () => current && setProjectOf({ folder, project: null }),
    );
    return () => {
      current = false;
    };
  }, [client, folder]);
  const project = projectOf?.folder === folder ? projectOf.project : null;
  // A Project's folder that is not on this computer gives way to a ticketd folder.
  useEffect(() => {
    const path = start?.folder;
    if (!path) return;
    let current = true;
    client.folderFiles(path, "").then(
      () => {},
      () => {
        if (!current) return;
        setFolder((chosen) => (chosen === path ? null : chosen));
        setFolderMissing(true);
      },
    );
    return () => {
      current = false;
    };
  }, [client, start?.folder]);
  const found = harnesses ?? [];
  // The one chosen here, else the last one used while it can still be, else the
  // first that can be used, in the host's order.
  const remembered = rememberedHarness();
  const harness =
    found.find((item) => item.id === harnessId) ??
    found.find((item) => item.id === remembered && item.usable) ??
    found.find((item) => item.usable) ??
    found[0];
  const ready = harness?.usable ?? false;
  // What each usable harness offers, asked once per harness version by the host.
  const [options, setOptions] = useState<Record<string, HarnessOptions>>({});
  const harnessKey = harness?.usable ? harness.id : null;
  useEffect(() => {
    if (!harnessKey) return;
    let current = true;
    client.harnessOptions(harnessKey).then(
      (found) =>
        current && setOptions((known) => ({ ...known, [harnessKey]: found })),
      (reason: unknown) =>
        current &&
        setOptions((known) => ({
          ...known,
          [harnessKey]: {
            harness_id: harnessKey,
            models: [],
            unavailable: describeFailure(reason, "list models").sentence,
          },
        })),
    );
    return () => {
      current = false;
    };
  }, [client, harnessKey, probe]);
  const offered = harness ? options[harness.id] : undefined;
  // The last pick for this harness while the harness still offers it, else
  // its listed defaults: what the picker shows is what the first turn runs on.
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const pick = harness
    ? startPick(offered, picks[harness.id] ?? rememberedPick(harness.id))
    : NO_PICK;
  const choosePick = (next: Pick) => {
    if (!harness) return;
    setPicks((known) => ({ ...known, [harness.id]: next }));
    rememberPick(harness.id, next);
  };
  const folderName = folder?.split(/[\\/]/).filter(Boolean).at(-1);
  const mentions = useMemo<ComposerMentions>(
    () => ({
      records: (query) => client.searchRecords(query),
      linked: links,
      ...(folder && {
        folder: {
          name: folderName ?? folder,
          files: (query: string) => client.folderFiles(folder, query),
        },
      }),
      harness: harness?.name ?? "Harness",
    }),
    [client, links, folder, folderName, harness?.name],
  );
  return (
    <section className="ticket-detail chat-pane" aria-labelledby="chat-heading">
      <div className="detail-header">
        <div className="detail-title-group">
          {!crumb && single && !expanded && (
            <IconButton label="Back to Chats" onClick={onReturn}>
              <ArrowLeft aria-hidden />
            </IconButton>
          )}
          {crumb}
          <h2 id="chat-heading" className="chat-head-title" tabIndex={-1}>
            New Chat
          </h2>
        </div>
        <div className="detail-actions">
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
          {!resting && (
            <IconButton label="Close New Chat" onClick={onClose}>
              <X aria-hidden />
            </IconButton>
          )}
        </div>
      </div>
      <OverlayBoundary element={body}>
        <div ref={setBody} className="chat-new">
          <div>
            <h2>What should we work on?</h2>
            <div
              className="chat-new-composer"
              onKeyDown={(event) => {
                // Undo right after choosing a suggestion takes back the prompt
                // and its links together.
                if (
                  (event.metaKey || event.ctrlKey) &&
                  !event.shiftKey &&
                  event.key.toLowerCase() === "z" &&
                  before &&
                  typed === before.prompt &&
                  undoChoice()
                )
                  event.preventDefault();
              }}
            >
              <Composer
                key={composerKey}
                autoFocus={!resting}
                inputRef={input}
                placeholder="Describe a task or ask a question"
                draft={draft}
                onText={(text) => {
                  if (before && text !== before.prompt) setBefore(null);
                }}
                mentions={mentions}
                above={
                  <ComposerQuotes quotes={quotes} onRemove={removeQuote} />
                }
                controls={(text, hasAttachments) => ({
                  send: "send",
                  enabled: ready && (text.trim() !== "" || hasAttachments),
                })}
                leading={
                  <NewChatControls
                    harnesses={found}
                    harnessId={harness?.id ?? null}
                    onHarness={(id) => {
                      setHarnessId(id);
                      rememberHarness(id);
                    }}
                    options={offered}
                    pick={pick}
                    onPick={choosePick}
                    notice={(id) => {
                      const other = found.find((item) => item.id === id);
                      return (
                        other?.problem && (
                          <ProblemNotice
                            flat
                            problem={other.problem}
                            harness={other.name}
                            onAction={() => setProbe((count) => count + 1)}
                          />
                        )
                      );
                    }}
                    onOpenChange={setPickerOpen}
                    inputRef={input}
                  />
                }
                retryRef={retrySend}
                onSend={async (typed, mentioned, attachments) => {
                  if (!harness) return;
                  const message = quotedMessage(quotes, typed);
                  const chosen = links.map(({ kind, id }) => ({ kind, id }));
                  const requestInput = {
                    harness_id: harness.id,
                    folder,
                    // Mentioned and quoted records link with the first message (21.4).
                    links: [
                      ...chosen,
                      ...mentioned,
                      ...quoteLinks(quotes),
                    ].filter(
                      (link, index, all) =>
                        all.findIndex(
                          (other) =>
                            other.kind === link.kind && other.id === link.id,
                        ) === index,
                    ),
                    message,
                    ...(attachments && { attachments }),
                    // The first turn runs on what the picker shows (LIVE-7).
                    ...(pick.model && { model: pick.model }),
                    ...(pick.effort && { effort: pick.effort }),
                    ...(pick.permission && { permission: pick.permission }),
                  };
                  const command_id = draft.requestId(
                    JSON.stringify(requestInput),
                  );
                  // Notifications are asked for with the first Chat message.
                  if (loadPreferences().notifyChats)
                    void notificationClient.requestPermission().catch(() => {});
                  try {
                    const created = await client.createChat({
                      command_id,
                      ...requestInput,
                    });
                    if (offered) rememberStart(created.chat_id, offered, pick);
                    if (folder) rememberFolder(folder);
                    clearQuotes(NEW_CHAT, quotes);
                    // The Chat exists but holds no message. Open it with the
                    // captured draft so a retry sends to the same Chat.
                    if (created.send_error) {
                      await draftOf(client, created.chat_id).recover({
                        text: message,
                        attachments: attachments ?? [],
                      });
                      arrivals.set(
                        created.chat_id,
                        `Your first message wasn’t sent. ${sentence(created.send_error)} It’s in the box below.`,
                      );
                    }
                    setFailure(null);
                    onCreated(created.chat_id);
                  } catch (reason) {
                    // Sending again repeats this same request safely.
                    setFailure(
                      chatFailure(reason, "start the Chat", () => {
                        input.current?.focus();
                        retrySend.current?.();
                      }),
                    );
                    throw reason;
                  }
                }}
              />
            </div>
            <div className="chat-chips">
              <DropdownMenu>
                <Tooltip
                  content={
                    folder
                      ? project
                        ? `${project.title} · ${folder}`
                        : folder
                      : "A new empty folder kept by ticketd"
                  }
                >
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="xs"
                      aria-label={folder ? `Folder: ${folder}` : SCRATCH}
                    >
                      {project ? (
                        <ProjectIcon project={project} />
                      ) : (
                        <Folder aria-hidden />
                      )}
                      <span className="chat-folder-label">
                        {folderName ? (
                          <>
                            <span className="chat-folder-prefix">Folder:</span>{" "}
                            {folderName}
                          </>
                        ) : (
                          SCRATCH
                        )}
                      </span>
                      <ChevronDown aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                </Tooltip>
                <DropdownMenuContent align="start" className="w-72">
                  {[...new Set([...(folder ? [folder] : []), ...recent])].map(
                    (path) => (
                      <DropdownMenuItem
                        key={path}
                        onSelect={() => setFolder(path)}
                      >
                        <FolderLine path={path} current={path === folder} />
                      </DropdownMenuItem>
                    ),
                  )}
                  <DropdownMenuItem onSelect={() => setFolder(null)}>
                    <span className="chat-folder-option">
                      <span className="chat-folder-option-line">
                        <span>{SCRATCH}</span>
                        {folder === null && <Check aria-hidden />}
                      </span>
                      <small>A new empty folder kept by ticketd</small>
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() =>
                      void client.pickFolder().then(
                        (path) => path && setFolder(path),
                        (reason: unknown) =>
                          setFailure(chatFailure(reason, "choose the folder")),
                      )
                    }
                  >
                    Choose a folder…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {links.map((record) => (
                <RecordChip
                  key={`${record.kind}:${record.id}`}
                  record={record}
                  onRemove={() =>
                    setLinks(links.filter((item) => item !== record))
                  }
                />
              ))}
              <LinkPicker
                withLabel
                linked={links}
                onPick={(record) => {
                  setLinks([...links, record]);
                  // A linked Project's folder is where its work happens: chosen
                  // for the Chat unless a folder was already picked.
                  if (record.kind !== "project" || folder !== null) return;
                  void client.projectFolder(record.id).then(
                    (path) => {
                      if (!path) return;
                      setFolder((chosen) => chosen ?? path);
                      setLinkedNote(`Using ${record.title}'s folder.`);
                    },
                    () => {},
                  );
                }}
              />
            </div>
          </div>
          <div>
            {prompt?.kept && start && (
              <p className="chat-fine">
                Draft kept ·{" "}
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={saving}
                  onClick={() => {
                    if (draft.setText(prompt.text, prompt.tokens, true)) {
                      setComposerKey((count) => count + 1);
                    }
                  }}
                >
                  Use {start.ticket.reference} prompt
                </Button>
              </p>
            )}
            {/* Suggestions or the harness's notice, never both: the notice's
              actions come next in Tab order. */}
            {typed.trim() === "" && !saving && !harness?.problem && (
              <Suggestions
                folder={folder}
                linked={links.flatMap((record) =>
                  record.kind === "ticket" ? [record.id] : [],
                )}
                onChoose={choose}
                refresh={seenFocus}
              />
            )}
            {/* The check is said, not shown: the picker holds its place
              meanwhile, so nothing moves when it ends (LIVE-11). */}
            <p className="sr-only" role="status">
              {harnesses
                ? linkedNote
                : "Checking which harnesses are installed…"}
            </p>
            {folderMissing && (
              <p className="chat-fine">
                Project folder isn’t on this computer; using a scratch folder.
              </p>
            )}
            {/* While the picker is open it shows this notice itself. */}
            {harness?.problem && !pickerOpen && (
              <ProblemNotice
                problem={harness.problem}
                harness={harness.name}
                onAction={() => setProbe((count) => count + 1)}
              />
            )}
            {failure && (
              <FailureAlert
                size="compact"
                failure={failure.failure}
                {...(failure.retry && { onRetry: failure.retry })}
              />
            )}
          </div>
        </div>
      </OverlayBoundary>
    </section>
  );
}
