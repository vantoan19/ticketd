import { failureText } from "@/lib/api/describe-failure";
import {
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from "react";
import { File, FileText, Folder, FolderKanban } from "lucide-react";
import { Reference } from "@/components/ui/reference";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import {
  isArchivedProjectRecord,
  type FolderFile,
  type HarnessSkill,
  type LinkedRecord,
} from "@/features/chats/client";
import { useWorkspaceChange } from "@/lib/workspace-change";
import { archivedProjectHint } from "@/features/projects/project-assignment";
import {
  insertToken,
  mentionText,
  reconcile,
  removeToken,
  stepOver,
  triggerAt,
  type Insert,
  type Token,
  type Trigger,
} from "@/features/chats/composer-mentions";

export type ComposerCommand = {
  name: string;
  description?: string | null | undefined;
  run?: (() => void) | undefined;
};

/** Where the composer's mention and command menus find what they offer. */
export type ComposerMentions = {
  /** Tickets, Documents and Projects by name. */
  records: (query: string) => Promise<LinkedRecord[]>;
  /** Shown under `#` before anything is typed. */
  linked: LinkedRecord[];
  /** The folder `@` lists; absent when there is none to read yet. */
  folder?: { name: string; files: (query: string) => Promise<FolderFile[]> };
  /** Commands the harness or Chat supports. */
  commands?: ComposerCommand[] | undefined;
  skills?:
    { folder: string | null; load: () => Promise<HarnessSkill[]> } | undefined;
  harness: string;
};

type Option = {
  id: string;
  insert: Insert;
  group: string;
  run?: (() => void) | undefined;
};
/** A search's answer, for the trigger `key` it was asked for. */
type Answer = {
  key: string;
  options: Option[];
  state: "ready" | "failed";
  error?: string;
  archivedProject?: string | undefined;
};

const RECORD_GROUPS = {
  ticket: "Tickets",
  document: "Documents",
  project: "Projects",
} as const;

function recordOptions(records: LinkedRecord[], group?: string): Option[] {
  return records.map((record) => ({
    id: `${record.kind}:${record.id}`,
    group: group ?? RECORD_GROUPS[record.kind],
    insert: { kind: "record", text: mentionText(record), record },
  }));
}

/**
 * Edits `textarea` through the browser's own editing, so ⌘Z undoes it; where
 * that is unavailable, `fallback` sets the text directly.
 */
function replaceRange(
  textarea: HTMLTextAreaElement,
  start: number,
  end: number,
  replacement: string,
  fallback: () => void,
) {
  textarea.focus();
  textarea.setSelectionRange(start, end);
  if (!browserEdit(replacement)) fallback();
}

function browserEdit(replacement: string) {
  try {
    return (
      typeof document.execCommand === "function" &&
      document.execCommand(
        replacement ? "insertText" : "delete",
        false,
        replacement,
      )
    );
  } catch {
    return false;
  }
}

/** Hands the box to the caller's ref as well as the field's own. */
function shareNode(
  ref: Ref<HTMLTextAreaElement> | undefined,
  node: HTMLTextAreaElement | null,
) {
  if (typeof ref === "function") ref(node);
  else if (ref) ref.current = node;
}

function OptionLabel({ option }: { option: Option }) {
  const pick = option.insert;
  if (pick.kind === "record") {
    const record = pick.record;
    if (record.kind === "ticket")
      return (
        <>
          <StatusIcon status={record.status} size={14} decorative />
          <Reference>{record.reference}</Reference>
          <span className="chat-menu-title">{record.title}</span>
        </>
      );
    return (
      <>
        {record.kind === "project" ? (
          <FolderKanban size={14} aria-hidden />
        ) : (
          <FileText size={14} aria-hidden />
        )}
        <span className="chat-menu-title">{record.title}</span>
      </>
    );
  }
  if (pick.kind === "path") {
    const parts = pick.text.split("/");
    const name = parts.pop() ?? pick.text;
    // LIVE-20: a nested file sits under its folder, one step in per level.
    const nested = { marginLeft: Math.min(parts.length, 4) * 12 };
    return (
      <>
        {option.group === "folder" ? (
          <Folder size={14} aria-hidden style={nested} />
        ) : (
          <File size={14} aria-hidden style={nested} />
        )}
        <span className="chat-menu-title">{name}</span>
        {parts.length > 0 && (
          <span className="chat-menu-detail">{parts.join("/")}</span>
        )}
      </>
    );
  }
  return <span className="chat-menu-mono">{pick.text}</span>;
}

/**
 * The composer's message box with its `#` record, `@` path and `/` command
 * menus. Inserted mentions are tokens over the plain text: a record is drawn
 * as a link (in a layer behind the text, so the text itself stays editable as
 * typed) and is linked when the message is sent. Focus never leaves the box;
 * while a menu is open the box is its combobox.
 */
export function ComposerField({
  text,
  tokens,
  onChange,
  onKeyDown,
  mentions,
  placeholder,
  autoFocus,
  readOnly,
  inputRef,
}: {
  text: string;
  tokens: Token[];
  onChange: (text: string, tokens: Token[]) => void;
  /** Keys the menus and tokens did not take: Enter, ↑. */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  mentions?: ComposerMentions | undefined;
  placeholder: string;
  autoFocus: boolean;
  readOnly: boolean;
  inputRef?: Ref<HTMLTextAreaElement> | undefined;
}) {
  const box = useRef<HTMLTextAreaElement | null>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [trigger, setTrigger] = useState<(Trigger & { text: string }) | null>(
    null,
  );
  /** The trigger Escape closed; it stays closed until another one starts. */
  const [dismissed, setDismissed] = useState<Pick<
    Trigger,
    "start" | "char"
  > | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [active, setActive] = useState(0);
  const [announce, setAnnounce] = useState("");
  const removed = useRef<Token[]>([]);
  /** A pick being inserted: added as a token once the edit lands. */
  const inserting = useRef<{ start: number; insert: Insert } | null>(null);
  const caretAfter = useRef<number | null>(null);

  useLayoutEffect(() => {
    const caret = caretAfter.current;
    if (caret === null || !box.current) return;
    caretAfter.current = null;
    box.current.setSelectionRange(caret, caret);
  });

  // The box opened with a prefill: the caret waits after it. Only the text the
  // box opened with counts, so this runs once.
  const caretAfterPrefill = useEffectEvent(() => {
    const field = box.current;
    if (autoFocus && field && text)
      field.setSelectionRange(text.length, text.length);
  });
  useLayoutEffect(() => caretAfterPrefill(), []);

  if (trigger && trigger.text !== text) {
    setTrigger(null);
    setDismissed(null);
  }
  const open =
    !readOnly &&
    trigger?.text === text &&
    (trigger.start !== dismissed?.start || trigger.char !== dismissed.char) &&
    mentions
      ? trigger
      : null;
  const openKey = open ? `${open.char}${open.start}:${open.query}` : "";
  const query = open?.query.trim() ?? "";
  const skillSearch = open?.char === "$" ? mentions?.skills : undefined;
  const searchingSkills = skillSearch !== undefined;
  const workspaceChange = useWorkspaceChange();
  const linkedProjects =
    open?.char === "#"
      ? mentions?.linked
          .filter(({ kind }) => kind === "project")
          .map((record) => [
            record.id,
            record.title,
            isArchivedProjectRecord(record),
          ])
      : undefined;
  // One folder lookup supplies every query until the skill menu closes.
  const searchKey = skillSearch
    ? `skills:${skillSearch.folder ?? ""}`
    : open?.char === "#"
      ? JSON.stringify([openKey, workspaceChange, linkedProjects])
      : openKey;
  // Linked records and the harness's commands are at hand; only searches wait.
  const atHand: Option[] | null =
    !open || !mentions
      ? null
      : open.char === "/"
        ? (mentions.commands ?? [])
            .filter((command) =>
              command.name.toLowerCase().includes(query.toLowerCase()),
            )
            .map((command) => ({
              id: command.name,
              group: command.description ?? "",
              insert: { kind: "command", text: `/${command.name}` },
              run: command.run,
            }))
        : null;
  // `#` with nothing typed: the linked records at once, then the recently
  // updated ones the host finds for an empty query.
  const linkedFirst =
    open?.char === "#" && !query && mentions
      ? recordOptions(
          mentions.linked.filter((record) => !isArchivedProjectRecord(record)),
          "Linked to this Chat",
        )
      : null;
  const searches = Boolean(
    open && atHand === null && (open.char !== "$" || searchingSkills),
  );
  // What the open trigger asks for, read when its search changes.
  const search = useEffectEvent(
    ():
      | Promise<Pick<Answer, "options" | "archivedProject">>
      | null
      | undefined => {
      if (!open || !mentions) return null;
      if (open.char === "$")
        return skillSearch?.load().then((skills) => ({
          options: skills.map((skill): Option => ({
            id: skill.name,
            group: skill.description,
            insert: { kind: "skill", text: `$${skill.name}` },
          })),
        }));
      const folder = mentions.folder;
      return open.char === "#"
        ? mentions.records(query).then((found) => {
            const eligible = found.filter(
              (record) => !isArchivedProjectRecord(record),
            );
            return {
              archivedProject:
                eligible.length === 0
                  ? found.find(isArchivedProjectRecord)?.title
                  : undefined,
              options: linkedFirst
                ? [
                    ...linkedFirst,
                    ...recordOptions(
                      eligible.filter(
                        (record) =>
                          !mentions.linked.some(
                            (linked) =>
                              linked.kind === record.kind &&
                              linked.id === record.id,
                          ),
                      ),
                      "Recent",
                    ),
                  ]
                : recordOptions(
                    eligible.sort(
                      (a, b) =>
                        Object.keys(RECORD_GROUPS).indexOf(a.kind) -
                        Object.keys(RECORD_GROUPS).indexOf(b.kind),
                    ),
                  ),
            };
          })
        : folder
          ? folder.files(query).then((files) => ({
              options: files.map((file): Option => ({
                id: file.path,
                group: file.folder ? "folder" : "file",
                insert: { kind: "path", text: file.path },
              })),
            }))
          : null;
    },
  );
  useEffect(() => {
    if (!searches) return;
    let current = true;
    search()?.then(
      (result) =>
        current && setAnswer({ key: searchKey, ...result, state: "ready" }),
      (reason: unknown) =>
        current &&
        setAnswer({
          key: searchKey,
          options: [],
          state: "failed",
          error: failureText(
            reason,
            searchingSkills ? "load skills" : "search",
          ),
        }),
    );
    return () => {
      current = false;
    };
  }, [searchKey, searches, searchingSkills]);
  // A new trigger starts at its first option.
  const [activeFor, setActiveFor] = useState(openKey);
  if (activeFor !== openKey) {
    setActiveFor(openKey);
    setActive(0);
  }

  const commandsListed = (mentions?.commands?.length ?? 0) > 0;
  const answered = answer?.key === searchKey ? answer : null;
  const matches = searchingSkills
    ? answered?.options.filter((option) =>
        option.id.toLowerCase().includes(query.toLowerCase()),
      )
    : answered?.options;
  const shown =
    open &&
    !(open.char === "/" && !commandsListed) &&
    !(open.char === "$" && !searchingSkills) &&
    !(open.char === "@" && !mentions?.folder)
      ? {
          trigger: open,
          options: atHand ?? matches ?? linkedFirst ?? [],
          state:
            atHand || (!answered && linkedFirst?.length)
              ? "ready"
              : (answered?.state ?? "searching"),
          error: answered?.error,
        }
      : null;
  const options = shown?.options ?? [];

  const updateTrigger = (value: string, caret: number) => {
    const found = triggerAt(value, caret);
    setTrigger(found && { ...found, text: value });
    if (
      dismissed &&
      (value.charAt(dismissed.start) !== dismissed.char ||
        (found &&
          (found.start !== dismissed.start || found.char !== dismissed.char)))
    )
      setDismissed(null);
  };

  const changed = (next: string, caret: number) => {
    let nextTokens = reconcile(text, next, tokens, removed.current);
    const pick = inserting.current;
    if (pick) {
      inserting.current = null;
      const token = {
        ...pick.insert,
        start: pick.start,
        end: pick.start + pick.insert.text.length,
      } as Token;
      nextTokens = [
        ...nextTokens.filter(
          (item) => item.end <= token.start || item.start >= token.end,
        ),
        token,
      ].sort((a, b) => a.start - b.start);
    }
    onChange(next, nextTokens);
    updateTrigger(next, caret);
  };

  const pick = (option: Option) => {
    const textarea = box.current;
    if (!textarea || !open) return;
    const caret = textarea.selectionStart;
    if (option.run) {
      replaceRange(textarea, open.start, caret, "", () => {
        caretAfter.current = open.start;
        changed(text.slice(0, open.start) + text.slice(caret), open.start);
      });
      setTrigger(null);
      option.run();
      return;
    }
    const after = text.slice(caret);
    const spaced = /^\s/.test(after)
      ? option.insert.text
      : `${option.insert.text} `;
    inserting.current = { start: open.start, insert: option.insert };
    replaceRange(textarea, open.start, caret, spaced, () => {
      inserting.current = null;
      const inserted = insertToken(text, tokens, open, caret, option.insert);
      caretAfter.current = inserted.caret;
      onChange(inserted.text, inserted.tokens);
    });
    setTrigger(null);
    setAnnounce(
      option.insert.kind === "record"
        ? `Inserted ${option.insert.text}. Links when you send.`
        : `Inserted ${option.insert.text}.`,
    );
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    const textarea = event.currentTarget;
    if (shown) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (options.length === 0) return;
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((index) => (index + step + options.length) % options.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const option = options[active];
        if (option) {
          // Inserting never sends.
          event.preventDefault();
          pick(option);
          return;
        }
        // While the menu is open, Enter never sends, even with no row to
        // insert yet (still searching, or nothing matches) (CH-46).
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          return;
        }
      }
      if (event.key === "Escape") {
        // Closes the menu and keeps the text; a second Escape is Stop's.
        event.preventDefault();
        event.stopPropagation();
        const { start, char } = shown.trigger;
        setDismissed({ start, char });
        return;
      }
    }
    const caret = textarea.selectionStart;
    const collapsed = caret === textarea.selectionEnd;
    const plain = !event.shiftKey && !event.metaKey && !event.altKey;
    if (collapsed && plain && !event.ctrlKey) {
      if (!readOnly && (event.key === "Backspace" || event.key === "Delete")) {
        const removal = removeToken(
          text,
          tokens,
          caret,
          event.key === "Backspace" ? "back" : "forward",
        );
        if (removal) {
          event.preventDefault();
          removed.current = [...removed.current.slice(-19), removal.removed];
          replaceRange(
            textarea,
            removal.removed.start,
            removal.removed.end,
            "",
            () => {
              caretAfter.current = removal.caret;
              onChange(removal.text, removal.tokens);
            },
          );
          setAnnounce(`Removed ${removal.removed.text}.`);
          return;
        }
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const to = stepOver(
          tokens,
          caret,
          event.key === "ArrowLeft" ? "left" : "right",
        );
        if (to !== null) {
          event.preventDefault();
          textarea.setSelectionRange(to, to);
          return;
        }
      }
    }
    onKeyDown(event);
  };

  const activeOption = options[active];
  const optionId = (index: number) => `${listId}-${index}`;
  const groups: { name: string; items: { option: Option; index: number }[] }[] =
    [];
  if (shown?.trigger.char === "#")
    options.forEach((option, index) => {
      const group = groups.find((item) => item.name === option.group);
      if (group) group.items.push({ option, index });
      else groups.push({ name: option.group, items: [{ option, index }] });
    });
  else if (shown)
    groups.push({
      name:
        shown.trigger.char === "@"
          ? `Files in ${mentions?.folder?.name ?? "this folder"}`
          : `${mentions?.harness ?? "Harness"} ${shown.trigger.char === "$" ? "skills" : "commands"}`,
      items: options.map((option, index) => ({ option, index })),
    });
  const empty =
    shown && shown.state !== "searching" && options.length === 0
      ? shown.state === "failed"
        ? (shown.error ?? "Couldn't search.")
        : shown.trigger.char === "@"
          ? query
            ? `No file or folder matches “${query}”.`
            : "This Chat’s folder has no files yet."
          : shown.trigger.char === "#"
            ? !query
              ? "Type part of a name to find it."
              : answered?.archivedProject
                ? archivedProjectHint(answered.archivedProject)
                : "No ticket, Document or Project has that in its name."
            : shown.trigger.char === "$"
              ? query
                ? `No skill matches “${query}”.`
                : "No skills are available in this folder."
              : `No ${mentions?.harness ?? "harness"} command matches “${query}”.`
      : "";

  // The layer behind the text draws record tokens as links.
  const segments: { text: string; token?: Token }[] = [];
  let at = 0;
  for (const token of tokens) {
    if (token.start < at || token.end > text.length) continue;
    segments.push({ text: text.slice(at, token.start) });
    segments.push({ text: text.slice(token.start, token.end), token });
    at = token.end;
  }
  segments.push({ text: text.slice(at) });

  return (
    <div className="chat-composer-field">
      {shown && (
        <div className="chat-menu" role="presentation">
          <ul id={listId} role="listbox" aria-label={groups[0]?.name ?? "Menu"}>
            {groups.map((group) => (
              <li key={group.name} role="presentation">
                <div className="chat-menu-group" aria-hidden="true">
                  {group.name}
                </div>
                <ul role="group" aria-label={group.name}>
                  {group.items.map(({ option, index }) => (
                    <li
                      key={option.id}
                      id={optionId(index)}
                      role="option"
                      aria-selected={index === active}
                      className="chat-menu-option"
                      onMouseDown={(event) => {
                        // Keeps focus, and the caret, in the message box.
                        event.preventDefault();
                        pick(option);
                      }}
                      onMouseEnter={() => setActive(index)}
                    >
                      <OptionLabel option={option} />
                      {(option.insert.kind === "command" ||
                        option.insert.kind === "skill") &&
                        option.group && (
                          <span className="chat-menu-detail">
                            {option.group}
                          </span>
                        )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          {shown.state === "searching" && options.length === 0 && (
            <p className="chat-menu-note">Searching…</p>
          )}
          {empty && (
            <p
              className="chat-menu-note"
              role={shown.state === "failed" ? "alert" : undefined}
            >
              {empty}
            </p>
          )}
          {shown.trigger.char === "#" && (
            <p className="chat-menu-foot">Links when you send</p>
          )}
        </div>
      )}
      <div className="chat-composer-input">
        <div ref={mirror} className="chat-composer-mirror" aria-hidden="true">
          {segments.map((segment, index) =>
            segment.token?.kind === "record" ? (
              <span key={index} className="chat-token">
                {segment.text}
              </span>
            ) : (
              <span key={index}>{segment.text}</span>
            ),
          )}
          {"​"}
        </div>
        <textarea
          readOnly={readOnly}
          ref={(node) => {
            box.current = node;
            shareNode(inputRef, node);
          }}
          rows={1}
          aria-label={placeholder}
          placeholder={placeholder}
          value={text}
          autoFocus={autoFocus}
          {...(shown && {
            role: "combobox",
            "aria-expanded": true,
            "aria-controls": listId,
            "aria-autocomplete": "list" as const,
            ...(activeOption && {
              "aria-activedescendant": optionId(active),
            }),
          })}
          onChange={(event) =>
            changed(event.target.value, event.target.selectionStart)
          }
          onSelect={(event) => {
            const target = event.currentTarget;
            if (target.selectionStart !== target.selectionEnd) return;
            updateTrigger(target.value, target.selectionStart);
          }}
          onScroll={(event) => {
            if (mirror.current)
              mirror.current.scrollTop = event.currentTarget.scrollTop;
          }}
          onKeyDown={onKey}
        />
      </div>
      <div className="sr-only" aria-live="polite">
        {shown && shown.state === "ready"
          ? `${options.length} ${options.length === 1 ? "result" : "results"}`
          : announce}
      </div>
    </div>
  );
}
