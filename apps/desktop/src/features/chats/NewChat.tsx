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
import {
  ChatFolderChoices,
  SCRATCH_FOLDER,
} from "@/features/chats/ChatFolderChoices";
import { ProjectIcon } from "@/features/projects/ProjectIcon";
import { Composer } from "@/features/chats/Composer";
import { useWorkspaceChange } from "@/lib/workspace-change";
import type { Token } from "@/features/chats/composer-mentions";
import { useCodexCommands } from "@/features/chats/composer-settings";
import type { ComposerMentions } from "@/features/chats/ComposerField";
import { ComposerQuotes } from "@/features/chats/ComposerQuote";
import { arrivals, draftOf, type PendingCreate } from "@/features/chats/drafts";
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
import type { Project } from "@/lib/api/client";
import { notificationClient } from "@/lib/api/notifications";
import { withoutVerbatim } from "@/lib/paths";
import { loadPreferences } from "@/lib/preferences";

const pickParameters = ({ model, effort, permission }: Pick) => ({
  ...(model && { model }),
  ...(effort && { effort }),
  ...(permission && { permission }),
});

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
  projects,
}: {
  projects?: readonly Project[] | undefined;
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
  const {
    text: typed,
    saving,
    pendingCreate,
  } = useSyncExternalStore(draft.subscribe, draft.snapshot);
  const [composerKey, setComposerKey] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [folderMissing, setFolderMissing] = useState(false);
  const [recent] = useState(recentFolders);
  const { quotes, remove: removeQuote } = useQuotes(NEW_CHAT);
  /** null until the first probe answers: seconds, while each harness is asked. */
  const [harnesses, setHarnesses] = useState<HarnessStatus[] | null>(null);
  const [harnessId, setHarnessId] = useState(
    () => pendingCreate?.request.harness_id ?? "",
  );
  /** null is the managed folder ticketd keeps for the Chat. */
  const [folder, setFolder] = useState<string | null>(() =>
    start ? start.folder : (pendingCreate?.request.folder ?? null),
  );
  const [links, setLinks] = useState<LinkedRecord[]>(() =>
    start ? [start.ticket] : (pendingCreate?.links ?? []),
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
  const workspaceChange = useWorkspaceChange();
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
  }, [client, folder, workspaceChange]);
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
  // A pending create keeps its pick through automatic harness probes and reopening.
  const [restoredPick, setRestoredPick] = useState(
    () =>
      pendingCreate && {
        harnessId: pendingCreate.request.harness_id,
        pick: pendingCreate.pick,
      },
  );
  const restored =
    restoredPick?.harnessId === harness?.id ? restoredPick?.pick : undefined;
  const pick = harness
    ? startPick(
        offered,
        restored ?? picks[harness.id] ?? rememberedPick(harness.id),
      )
    : NO_PICK;
  const choosePick = (next: Pick) => {
    if (!harness) return;
    setRestoredPick(null);
    setPicks((known) => ({ ...known, [harness.id]: next }));
    rememberPick(harness.id, next);
  };
  const folderName = folder?.split(/[\\/]/).filter(Boolean).at(-1);
  const codex = harness?.id === "codex";
  const canListSkills = codex && ready;
  const { commands, openers } = useCodexCommands(
    codex,
    Boolean(offered?.permission?.changeable),
  );
  const currentLinks = useMemo(
    () =>
      links.map((record) => {
        if (record.kind !== "project") return record;
        const project = projects?.find(({ id }) => id === record.id);
        return project
          ? {
              ...record,
              title: project.name,
              archived: Boolean(project.archived),
            }
          : record;
      }),
    [links, projects],
  );
  const mentions = useMemo<ComposerMentions>(
    () => ({
      records: (query) => client.searchRecords(query),
      linked: currentLinks,
      ...(folder && {
        folder: {
          name: folderName ?? folder,
          files: (query: string) => client.folderFiles(folder, query),
        },
      }),
      commands,
      skills: canListSkills
        ? { folder, load: () => client.harnessSkills("codex", folder) }
        : undefined,
      harness: harness?.name ?? "Harness",
    }),
    [
      client,
      currentLinks,
      folder,
      folderName,
      harness?.name,
      commands,
      canListSkills,
    ],
  );
  const create = async (pending: PendingCreate, keepDraft = false) => {
    const { request, options, pick, quotes } = pending;
    // Notifications are asked for with the first Chat message.
    if (loadPreferences().notifyChats)
      void notificationClient.requestPermission().catch(() => {});
    try {
      const created = await client.createChat(request);
      if (!draft.belongsToWorkspace()) return;
      if (options) rememberStart(created.chat_id, options, pick);
      if (request.folder) rememberFolder(request.folder);
      clearQuotes(NEW_CHAT, quotes);
      // The Chat exists but holds no message. Open it with the captured draft.
      if (created.send_error) {
        await draftOf(client, created.chat_id).recover({
          text: request.message,
          attachments: request.attachments ?? [],
        });
        if (!draft.belongsToWorkspace()) return;
        arrivals.set(
          created.chat_id,
          `Your first message wasn’t sent. ${sentence(created.send_error)} It’s in the box below.`,
        );
      }
      if (keepDraft) draft.settleCreateInput(pending.submitted);
      draft.setPendingCreate(null);
      setRestoredPick(null);
      setFailure(null);
      if (
        input.current?.isConnected &&
        !input.current.closest('[hidden], [data-single="list"]')
      )
        onCreated(created.chat_id);
    } catch (reason) {
      draft.setPendingCreate({
        ...pending,
        failure: describeFailure(reason, "start the Chat"),
      });
      throw reason;
    }
  };
  const retryCreate = () => {
    const current = draft.snapshot();
    const pending = current.pendingCreate;
    if (!pending?.failure) return;
    input.current?.focus();
    const { submitted } = pending;
    const keepDraft =
      current.text !== submitted.text ||
      current.tokens !== submitted.tokens ||
      current.items !== submitted.items;
    // The host may already have committed this exact command.
    draft.save("send", () => create(pending, keepDraft), keepDraft);
  };
  const shownFailure = pendingCreate?.failure ?? failure?.failure;
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
                      if (id !== harness?.id) setRestoredPick(null);
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
                    openers={openers}
                  />
                }
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
                  };
                  const previous = draft.snapshot().pendingCreate;
                  // An unchanged request can reconcile its original create after
                  // a probe changes the choices. Edited requests use today's pick.
                  if (
                    previous &&
                    restored &&
                    draft.repeatsRequest(
                      JSON.stringify({
                        ...requestInput,
                        ...pickParameters(restored),
                      }),
                    )
                  ) {
                    await create(previous);
                    return;
                  }
                  // The first turn runs on what the picker shows (LIVE-7).
                  const selectedInput = {
                    ...requestInput,
                    ...pickParameters(pick),
                  };
                  const request = {
                    command_id: draft.requestId(JSON.stringify(selectedInput)),
                    ...selectedInput,
                  };
                  const { text, tokens, items } = draft.snapshot();
                  const pending: PendingCreate = {
                    request,
                    links,
                    quotes,
                    options: offered,
                    pick,
                    submitted: { text, tokens, items },
                    failure: null,
                  };
                  draft.setPendingCreate(pending);
                  setRestoredPick({ harnessId: harness.id, pick });
                  setFailure(null);
                  await create(pending);
                }}
              />
            </div>
            <div className="chat-chips">
              <DropdownMenu>
                <Tooltip
                  content={
                    folder
                      ? project
                        ? `${project.title} · ${withoutVerbatim(folder)}`
                        : withoutVerbatim(folder)
                      : "A new empty folder kept by ticketd"
                  }
                >
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="xs"
                      aria-label={
                        folder
                          ? `Folder: ${withoutVerbatim(folder)}`
                          : SCRATCH_FOLDER
                      }
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
                          SCRATCH_FOLDER
                        )}
                      </span>
                      <ChevronDown aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                </Tooltip>
                <DropdownMenuContent align="start" className="w-72">
                  <ChatFolderChoices
                    draft={{ folder, recent, onScratch: () => setFolder(null) }}
                    onPick={setFolder}
                    onBrowseError={(reason) =>
                      setFailure(chatFailure(reason, "choose the folder"))
                    }
                  />
                </DropdownMenuContent>
              </DropdownMenu>
              {currentLinks.map((record) => (
                <RecordChip
                  key={`${record.kind}:${record.id}`}
                  record={record}
                  onRemove={() =>
                    setLinks((linked) =>
                      linked.filter(
                        (item) =>
                          item.kind !== record.kind || item.id !== record.id,
                      ),
                    )
                  }
                />
              ))}
              <LinkPicker
                withLabel
                linked={currentLinks}
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
            {folderMissing && folder === null && (
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
            {shownFailure && (
              <FailureAlert
                size="compact"
                failure={shownFailure}
                {...(pendingCreate?.failure
                  ? { onRetry: retryCreate }
                  : failure?.retry && { onRetry: failure.retry })}
              />
            )}
          </div>
        </div>
      </OverlayBoundary>
    </section>
  );
}
