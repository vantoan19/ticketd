import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import {
  useChatClient,
  type HarnessStatus,
  type LinkedRecord,
  type ProblemKind,
  type Suggestion,
} from "@/features/chats/client";
import { ProblemNotice } from "@/features/chats/ChatDetail";
import { Composer } from "@/features/chats/Composer";
import type { Token } from "@/features/chats/composer-mentions";
import type { ComposerMentions } from "@/features/chats/ComposerField";
import { ComposerQuotes } from "@/features/chats/ComposerQuote";
import { carryIntoChat } from "@/features/chats/drafts";
import {
  NEW_CHAT,
  clearQuotes,
  quoteLinks,
  quotedMessage,
  useQuotes,
} from "@/features/chats/quotes";
import { ticketPrompt, type TicketStart } from "@/features/chats/ticket-chat";
import { LinkPicker, RecordChip } from "@/features/chats/LinkPicker";
import { HarnessMark } from "@/features/chats/HarnessMark";
import { harnessUsable, harnessWord } from "@/features/chats/model";
import { suggestionFill } from "@/features/chats/suggestion-fill";
import { Suggestions } from "@/features/chats/Suggestions";
import { StatusDot } from "@/components/ui/status-dot";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { RadioGroup } from "radix-ui";
import { notificationClient } from "@/lib/api/notifications";
import { loadPreferences } from "@/lib/preferences";

const STATUS_PROBLEM: Record<
  Exclude<HarnessStatus["status"], "ready">,
  ProblemKind
> = {
  not_installed: "not_installed",
  incompatible: "incompatible",
  unavailable: "unavailable",
  not_signed_in: "not_signed_in",
  not_subscription: "not_subscription",
  sign_in_unknown: "sign_in_unknown",
  unknown: "probe_failed",
};

/**
 * The harness choice: one 48px radio per harness with its mark and name, and
 * a muted word only when it isn't ready. Arrow keys choose; the draft and the
 * composer stay where they are. What to do about a harness is in the notice.
 */
function HarnessRadios({
  harnesses,
  value,
  onChange,
}: {
  harnesses: HarnessStatus[] | null;
  value: string;
  onChange: (id: string) => void;
}) {
  if (!harnesses)
    return (
      <p className="chat-harness-checking" role="status">
        Checking which harnesses are installed…
      </p>
    );
  if (harnesses.length === 0) return null;
  return (
    <TooltipProvider delayDuration={400}>
      <RadioGroup.Root
        className="chat-harnesses"
        aria-label="Harness"
        value={value}
        onValueChange={onChange}
      >
        {harnesses.map((item) => {
          const word = harnessWord(item.status);
          return (
            <Tooltip key={item.id}>
              <TooltipTrigger asChild>
                <RadioGroup.Item
                  value={item.id}
                  className="chat-harness"
                  aria-label={word ? `${item.name}, ${word.word}` : item.name}
                >
                  <span className="chat-harness-radio" aria-hidden="true">
                    <RadioGroup.Indicator />
                  </span>
                  <HarnessMark
                    harness={item.id}
                    name={item.name}
                    dim={item.status === "not_installed"}
                    decorative
                  />
                  <span className="chat-harness-name">{item.name}</span>
                  {word && (
                    <span className="chat-harness-word">
                      {word.dot && <StatusDot tone="attention" />}
                      {word.word}
                    </span>
                  )}
                </RadioGroup.Item>
              </TooltipTrigger>
              <TooltipContent>
                {[
                  item.version && `${item.name} ${item.version}`,
                  "A Chat keeps its harness",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </RadioGroup.Root>
    </TooltipProvider>
  );
}

/** The draft survives leaving and returning to New Chat while the app is open. */
let draft = "";
let draftTokens: Token[] = [];
/** The ticket prompt the draft was prefilled with, while nobody has edited it. */
let prefilled: string | null = null;

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
}: {
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
  // A prefill nobody edited is replaced; a draft someone typed is kept, with
  // the ticket's prompt one click away.
  const [prompt] = useState(() => {
    if (!start) return null;
    const next = ticketPrompt(start.ticket);
    const kept = draft.trim() !== "" && draft !== prefilled;
    if (!kept) {
      draft = next.text;
      draftTokens = next.tokens;
      prefilled = next.text;
    }
    return { ...next, kept };
  });
  const [composerKey, setComposerKey] = useState(0);
  const [folderMissing, setFolderMissing] = useState(false);
  const { quotes, remove: removeQuote } = useQuotes(NEW_CHAT);
  /** null until the first probe answers: seconds, while each harness is asked. */
  const [harnesses, setHarnesses] = useState<HarnessStatus[] | null>(null);
  const [harnessId, setHarnessId] = useState("");
  /** null is the managed folder ticketd keeps for the Chat. */
  const [folder, setFolder] = useState<string | null>(
    () => start?.folder ?? null,
  );
  const [shared, setShared] = useState(0);
  const [links, setLinks] = useState<LinkedRecord[]>(() =>
    start ? [start.ticket] : [],
  );
  const [failure, setFailure] = useState("");
  const [probe, setProbe] = useState(0);
  // Suggestions show only while the box is empty. Choosing one refills the box
  // (remounting the composer with the prompt) and links its records; both are
  // one undo step, kept in `before`.
  const [typed, setTyped] = useState(draft);
  const [before, setBefore] = useState<{
    text: string;
    tokens: Token[];
    links: LinkedRecord[];
    prompt: string;
  } | null>(null);
  const [linkedNote, setLinkedNote] = useState("");
  const [refilled, setRefilled] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const box = input.current;
    if (!refilled || !box) return;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }, [refilled]);
  const refill = (text: string, tokens: Token[]) => {
    draft = text;
    draftTokens = tokens;
    prefilled = null;
    setTyped(text);
    setComposerKey((count) => count + 1);
    setRefilled((count) => count + 1);
  };
  const choose = (suggestion: Suggestion) => {
    const { prompt: text, links: chosen } = suggestionFill(suggestion);
    const added = chosen.filter(
      (record) =>
        !links.some(
          (item) => item.kind === record.kind && item.id === record.id,
        ),
    );
    setBefore({ text: draft, tokens: draftTokens, links, prompt: text });
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
    if (!before) return false;
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
  const attempt = useRef({ id: crypto.randomUUID(), request: "" });
  useEffect(() => {
    let current = true;
    client.harnesses().then(
      (found) => current && setHarnesses(found),
      (reason: unknown) => current && setFailure(String(reason)),
    );
    return () => {
      current = false;
    };
  }, [client, probe]);
  useEffect(() => {
    let current = true;
    (folder ? client.folderUse(folder) : Promise.resolve(0)).then(
      (count) => current && setShared(count),
      () => current && setShared(0),
    );
    return () => {
      current = false;
    };
  }, [client, folder]);
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
  const harness =
    found.find((item) => item.id === harnessId) ??
    found.find((item) => item.status === "ready") ??
    found.find((item) => harnessUsable(item.status)) ??
    found[0];
  const ready = harness !== undefined && harnessUsable(harness.status);
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
          {!crumb && single && (
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
          <IconButton label="Close Chat" onClick={onClose}>
            <X aria-hidden />
          </IconButton>
        </div>
      </div>
      <div className="chat-new">
        <div>
          <h2>What should we work on?</h2>
          <HarnessRadios
            harnesses={harnesses}
            value={harness?.id ?? ""}
            onChange={setHarnessId}
          />
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
              autoFocus
              inputRef={input}
              placeholder="Describe a task or ask a question"
              initialText={draft}
              initialTokens={draftTokens}
              onText={(text, tokens) => {
                draft = text;
                draftTokens = tokens;
                if (text !== prefilled) prefilled = null;
                setTyped(text);
                if (before && text !== before.prompt) setBefore(null);
              }}
              mentions={mentions}
              above={<ComposerQuotes quotes={quotes} onRemove={removeQuote} />}
              controls={(text) => ({
                send: "send",
                enabled: ready && text.trim() !== "",
              })}
              onSend={async (typed, mentioned) => {
                if (!harness) return;
                const message = quotedMessage(quotes, typed);
                const chosen = links.map(({ kind, id }) => ({ kind, id }));
                const input = {
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
                };
                const request = JSON.stringify(input);
                if (attempt.current.request !== request)
                  attempt.current = { id: crypto.randomUUID(), request };
                // Notifications are asked for with the first Chat message.
                if (loadPreferences().notifyChats)
                  void notificationClient.requestPermission().catch(() => {});
                try {
                  const created = await client.createChat({
                    command_id: attempt.current.id,
                    ...input,
                  });
                  // Answered: whatever is asked for next is a new request.
                  attempt.current = { id: crypto.randomUUID(), request: "" };
                  clearQuotes(NEW_CHAT);
                  prefilled = null;
                  // The Chat exists but holds no message. It is opened with the
                  // unsent words in its composer, so they are sent there and no
                  // second Chat is made for them.
                  if (created.send_error)
                    carryIntoChat(
                      created.chat_id,
                      message,
                      `Your first message was not sent: ${created.send_error}. It is in the box below.`,
                    );
                  setFailure("");
                  onCreated(created.chat_id);
                } catch (reason) {
                  setFailure(
                    `Could not start the Chat: ${reason instanceof Error ? reason.message : String(reason)}`,
                  );
                  throw reason;
                }
              }}
            />
          </div>
          <div className="chat-chips">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="xs"
                  aria-label={`Folder: ${folder ?? "a folder kept by ticketd"}`}
                >
                  <Folder aria-hidden />
                  {folderName ?? "ticketd folder"}
                  <ChevronDown aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem
                  onSelect={() =>
                    void client.pickFolder().then(
                      (path) => path && setFolder(path),
                      (reason: unknown) => setFailure(String(reason)),
                    )
                  }
                >
                  Choose a folder…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setFolder(null)}>
                  Use a folder kept by ticketd
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
              onPick={(record) => setLinks([...links, record])}
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
                onClick={() => {
                  draft = prompt.text;
                  draftTokens = prompt.tokens;
                  prefilled = prompt.text;
                  setTyped(prompt.text);
                  setComposerKey((count) => count + 1);
                }}
              >
                Use {start.ticket.reference} prompt
              </Button>
            </p>
          )}
          {typed.trim() === "" && (
            <Suggestions
              folder={folder}
              linked={links.flatMap((record) =>
                record.kind === "ticket" ? [record.id] : [],
              )}
              onChoose={choose}
            />
          )}
          <p className="sr-only" role="status">
            {linkedNote}
          </p>
          {folderMissing && (
            <p className="chat-fine">
              Project folder isn’t on this computer; using a ticketd folder.
            </p>
          )}
          {shared > 0 && (
            <p className="chat-fine">
              {shared === 1
                ? "1 other Chat uses this folder."
                : `${shared} other Chats use this folder.`}
            </p>
          )}
          {harness && harness.status !== "ready" && (
            <ProblemNotice
              problem={{
                kind: STATUS_PROBLEM[harness.status],
                message: harness.message,
                command: harness.command,
                help_url: harness.help_url,
                path: harness.path,
              }}
              harness={harness.name}
              onAction={() => setProbe((count) => count + 1)}
            />
          )}
          {failure && (
            <p className="chat-fine" role="alert">
              {failure}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
