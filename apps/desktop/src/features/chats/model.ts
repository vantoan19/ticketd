import type {
  ChatChange,
  ChatSnapshot,
  ChatState,
  ChatStatus,
  Problem,
  RecordChange,
  Step,
  StepTarget,
  TranscriptItem,
  ItemOf,
} from "@/features/chats/client";

/**
 * Applies one change-log entry to the snapshot it follows. Returns "resync"
 * when the entry does not follow directly (a gap, or the host says the log no
 * longer reaches back), so the caller reopens the Chat instead of guessing.
 */
export function applyChange(
  snapshot: ChatSnapshot,
  change: ChatChange,
): ChatSnapshot | "resync" {
  if (change.seq <= snapshot.cursor) return snapshot;
  if (change.kind === "resync" || change.seq !== snapshot.cursor + 1)
    return "resync";
  const cursor = change.seq;
  if (change.kind === "chat") return { ...snapshot, chat: change.chat, cursor };
  if (change.kind === "text")
    return {
      ...snapshot,
      cursor,
      items: snapshot.items.map((item) =>
        item.id === change.item_id && item.kind === "response"
          ? { ...item, text: item.text + change.text }
          : item,
      ),
    };
  const known = snapshot.items.some((item) => item.id === change.item.id);
  return {
    ...snapshot,
    cursor,
    items: known
      ? snapshot.items.map((item) =>
          item.id === change.item.id ? change.item : item,
        )
      : [...snapshot.items, change.item],
  };
}

const count = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** Running, succeeded, and any other outcome; then what three or more count as. */
const STEP_VERBS = {
  read: ["Reading", "Read", "Read", "file"],
  list: ["Listing", "Listed", "List", "folder"],
  search: ["Searching for", "Searched for", "Search for", "time"],
  edit: ["Editing", "Edited", "Edit", "file"],
  create: ["Creating", "Created", "Create", "file"],
  delete: ["Deleting", "Deleted", "Delete", "file"],
  run: ["Running", "Ran", "Run", "command"],
  web: [
    "Searching the web for",
    "Searched the web for",
    "Search the web for",
    "time",
  ],
  fetch: ["Fetching", "Fetched", "Fetch", "page"],
  other: ["Using", "Used", "Use", "tool"],
} as const;

const OUTCOME_WORDS = {
  failed: "Failed",
  declined: "Declined",
  not_finished: "Not finished",
  unknown: "Not confirmed",
} as const;

export type StepWords = {
  /** The row's words in order; `code` ones are targets, shown in mono. */
  parts: { text: string; code?: boolean }[];
  /** At most one: an outcome word, or a muted result such as "No matches". */
  suffix?: { text: string; outcome: boolean };
  /** The row's accessible name: "Run npm run test:limiter, Failed". */
  label: string;
  /** The muted line under an opened row: "Exit 1 · in apps/desktop". */
  detail: string;
};

/**
 * "12s", "2m 13s", "10m", "1h 4m": how long something took or has run. The
 * one way a Chat says a time; never "0s".
 */
export function duration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 60) {
    const rest = minutes % 60;
    return rest ? `${Math.floor(minutes / 60)}h ${rest}m` : `${minutes / 60}h`;
  }
  return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
}

/** "lines 40–90" for a read that names its lines. */
export function targetLines(target: StepTarget): string {
  if (!target.lines) return "";
  const [from, to] = target.lines;
  return from === to ? `line ${from}` : `lines ${from}–${to}`;
}

/**
 * Every word of a step row: `[icon] Verb target · suffix`. Only a step that succeeded
 * is in the past tense; any other outcome keeps the plain verb and says its word.
 */
export function stepWords(step: Step): StepWords {
  const state = step.state ?? "done";
  const targets = step.targets ?? [];
  const key =
    step.kind === "read" && step.variant === "list"
      ? "list"
      : step.kind === "web" && step.variant === "fetch"
        ? "fetch"
        : step.kind;
  const [running, done, otherwise, noun] = STEP_VERBS[key];
  const verb =
    state === "running" ? running : state === "done" ? done : otherwise;
  const code = (text: string) => ({ text, code: true });
  const quoted = (text: string) => ({
    text: key === "web" ? `“${text}”` : text,
    code: key !== "web",
  });
  let parts: StepWords["parts"];
  if (step.kind === "other" && targets.length === 0) {
    parts = [{ text: step.target }];
  } else if (step.kind === "run" && step.variant === "script") {
    parts = [
      { text: `${verb} a` },
      code(targets[0]?.text ?? ""),
      { text: "script" },
    ];
  } else if (step.kind === "run") {
    const command = step.command ?? step.target;
    parts = [{ text: verb }, code(command.split("\n")[0] ?? command)];
  } else if (targets.length > 2) {
    // "Searched for" counts as "Searched 3 times".
    const counted = verb.replace(/ for$/, "");
    parts = [{ text: `${counted} ${count(targets.length, noun)}` }];
  } else if (targets.length === 0) {
    // `rg --files` lists files, not a folder it names.
    const what = key === "list" ? "file" : noun;
    parts = [
      {
        text: key === "search" ? verb.replace(/ for$/, "") : `${verb} ${what}s`,
      },
    ];
  } else {
    const [first, second] = targets;
    parts = [{ text: verb }, quoted(first?.text ?? "")];
    if (second) parts.push({ text: "and" }, quoted(second.text));
    else if (first?.scope && key === "search")
      parts.push({ text: "in" }, code(first.scope));
  }
  const suffix =
    state in OUTCOME_WORDS
      ? {
          text: OUTCOME_WORDS[state as keyof typeof OUTCOME_WORDS],
          outcome: true,
        }
      : state === "done" && step.no_matches
        ? { text: "No matches", outcome: false }
        : undefined;
  const words = parts.map((part) => part.text).join(" ");
  const single = targets.length === 1 && !step.command ? targets[0] : undefined;
  const detail = [
    step.timed_out
      ? `Timed out${step.duration_ms ? ` after ${duration(step.duration_ms)}` : ""}`
      : step.exit_code
        ? `Exit ${step.exit_code}`
        : "",
    step.folder ? `in ${step.folder}` : "",
    single ? targetLines(single) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    parts,
    ...(suffix && { suffix }),
    label: suffix ? `${words}, ${suffix.text}` : words,
    detail,
  };
}

/**
 * Consecutive steps of the same kind and outcome as one row ("Read 6 files"), which
 * opens to its targets. Commands never merge, so each one's output stays one level
 * down. A merged row keeps "No matches" only when all its steps found nothing.
 */
export function mergeSteps(steps: Step[]): Step[] {
  const rows: Step[] = [];
  for (const step of steps) {
    const last = rows.at(-1);
    const same =
      last &&
      step.kind !== "run" &&
      last.kind === step.kind &&
      (last.variant ?? null) === (step.variant ?? null) &&
      (last.state ?? "done") === (step.state ?? "done");
    if (!same) {
      rows.push(step);
      continue;
    }
    // A merged row opens to its targets, so no one step's output comes with it.
    const merged: Step = { ...last };
    delete merged.output;
    delete merged.result;
    delete merged.truncated;
    rows[rows.length - 1] = {
      ...merged,
      targets: [...(last.targets ?? []), ...(step.targets ?? [])],
      no_matches: Boolean(last.no_matches && step.no_matches),
    };
  }
  return rows;
}

/** A reasoning row with no text leaves the list once it ends; one cut off stays. */
export const reasoningShown = (item: ItemOf<"reasoning">) =>
  item.state !== "done" || Boolean(item.text?.trim());

/** A plan whose turn ended with every step done: one row in the fold. */
export const planFinished = (item: ItemOf<"plan">) =>
  item.state === "ended" &&
  item.steps.length > 0 &&
  item.steps.every((step) => step.status === "completed");

/** A plan its turn ended without finishing, or whose stop did not confirm: a card. */
export const planUnfinished = (item: ItemOf<"plan">) =>
  item.state !== "running" && item.steps.length > 0 && !planFinished(item);

/** One row of a turn, in the order it happened. `kept` rows are never folded. */
export type TurnRow =
  | {
      kind: "step";
      key: string;
      step: Step;
      /** The answered approval this step waited on: "You allowed this for this session". */
      decision?: string;
      kept?: false;
    }
  | { kind: "response"; key: string; item: ItemOf<"response">; kept?: false }
  | {
      kind: "record";
      key: string;
      change: RecordChange;
      kept?: false;
    }
  | { kind: "receipt"; key: string; item: ItemOf<"request">; kept: true }
  | { kind: "note"; key: string; item: ItemOf<"marker">; kept: true }
  /** #367: a reasoning row, and a plan that finished every step. */
  | { kind: "reasoning"; key: string; item: ItemOf<"reasoning">; kept?: false }
  | { kind: "plan"; key: string; item: ItemOf<"plan">; kept?: false };

/**
 * A turn, or one segment of it after a steer: your message's work through its end.
 * While it runs it shows its rows as they come; once it ends they fold under one
 * row, and the final response and the end marker stay outside.
 */
export type Turn = {
  key: string;
  /** Still running: nothing folds and there is no turn row. */
  live: boolean;
  /** Stop was asked for and not confirmed: the turn row shows, open. */
  unconfirmed: boolean;
  /** "Worked for 2m 13s · 1 failed". */
  label: string;
  rows: TurnRow[];
  /** The turn's last response, when no step follows it. */
  final?: ItemOf<"response">;
  /** Why the turn stopped: stopped, quit or failed. */
  marker?: ItemOf<"marker">;
  /** A plan the turn ended with unfinished: a card above the final response. */
  plan?: ItemOf<"plan">;
  /** The files the turn changed, below the response and stop marker. */
  files?: ItemOf<"files">;
  /** The turn ran commands that edited files the files row cannot list. */
  commandEdits?: boolean;
  /** Every item the turn holds, for the reading position. */
  ids: string[];
};

export type TranscriptPart =
  { kind: "item"; item: TranscriptItem } | { kind: "turn"; turn: Turn };

/** What the turn row says, by how the segment ended. */
const TURN_WORDS = {
  worked: ["Worked for", "Worked"],
  continued: ["Continued for", "Continued"],
  stopped: ["Stopped after", "Stopped"],
  failed: ["Failed after", "Failed"],
  unconfirmed: ["Stop not confirmed after", "Stop not confirmed"],
} as const;

const PROBLEM_COUNTS = [
  ["failed", "failed"],
  ["declined", "declined"],
  ["not_finished", "not finished"],
  ["unknown", "not confirmed"],
] as const;

type Segment = {
  turnId?: string;
  steer: boolean;
  started?: string;
  /** Set when a steer ended the segment while its turn went on. */
  until?: string;
  members: TranscriptItem[];
};

/** The last element that passes `test`. */
function lastOf<T, S extends T>(
  list: readonly T[],
  test: (value: T) => value is S,
): S | undefined;
function lastOf<T>(
  list: readonly T[],
  test: (value: T) => boolean,
): T | undefined;
function lastOf<T>(list: readonly T[], test: (value: T) => boolean) {
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const value = list[index];
    if (value !== undefined && test(value)) return value;
  }
  return undefined;
}

const time = (stamp: string | null | undefined) => {
  const value = stamp ? Date.parse(stamp) : NaN;
  return Number.isNaN(value) ? undefined : value;
};

/** "Answered · Fail open", "Expired · rm -rf dist": a request's receipt row. */
export function receiptLine(request: ItemOf<"request">) {
  const subject = request.subject ?? request.title;
  if (request.state === "expired") return `Expired · ${subject}`;
  return `Answered · ${request.answer ?? subject}`;
}

/**
 * A turn's rows in order, and every step as it now reads. Steps merge across the
 * items they arrived in. `running` is what a step still running reads as: running,
 * or Not finished once its turn ended, or Not confirmed after an unconfirmed stop.
 */
function rowsOf(members: TranscriptItem[], running: Step["state"]) {
  const rows: TurnRow[] = [];
  const all: Step[] = [];
  let steps: { key: string; step: Step }[] = [];
  const flush = () => {
    const first = steps[0]?.key ?? "";
    mergeSteps(steps.map((entry) => entry.step)).forEach((step, index) =>
      rows.push({ kind: "step", key: `${first}:${index}`, step }),
    );
    steps = [];
  };
  for (const item of members) {
    if (item.kind === "steps") {
      item.steps.forEach((original, index) => {
        const step =
          original.state === "running" && running !== "running"
            ? { ...original, state: running }
            : original;
        all.push(step);
        const key = `${item.id}:${index}`;
        if (step.decision) {
          // A step the person decided about stands alone, so its tooltip is its own.
          flush();
          rows.push({ kind: "step", key, step, decision: step.decision });
        } else steps.push({ key, step });
      });
      continue;
    }
    flush();
    // The host told the decision on the step it was asked for.
    if (item.kind === "request" && item.folded) continue;
    if (item.kind === "response")
      rows.push({ kind: "response", key: item.id, item });
    else if (item.kind === "reasoning") {
      if (reasoningShown(item))
        rows.push({ kind: "reasoning", key: item.id, item });
    } else if (item.kind === "plan") {
      if (planFinished(item)) rows.push({ kind: "plan", key: item.id, item });
    } else if (item.kind === "records")
      item.changes.forEach((change, index) =>
        rows.push({ kind: "record", key: `${item.id}:${index}`, change }),
      );
    else if (item.kind === "request" && item.state !== "pending")
      rows.push({ kind: "receipt", key: item.id, item, kept: true });
    else if (item.kind === "marker" && item.reason === "note")
      rows.push({ kind: "note", key: item.id, item, kept: true });
  }
  flush();
  return { rows, steps: all };
}

/**
 * The transcript as turns: each runs from your message through the turn's end, and
 * a steer starts a new segment of the same turn. Messages, session dividers and
 * anything outside a turn stay single items. `now` measures a turn whose stop was
 * not confirmed, which has not ended.
 */
export function turns(
  items: TranscriptItem[],
  chat: Pick<ChatState, "activity" | "problem">,
  now = Date.now(),
): TranscriptPart[] {
  const timings = new Map<string, ItemOf<"turn">>();
  for (const item of items)
    if (item.kind === "turn") timings.set(item.turn_id, item);
  const parts: (TranscriptPart | Segment)[] = [];
  let open: Segment | undefined;
  for (const item of items) {
    if (item.kind === "turn") continue;
    if (item.kind === "request" && item.state === "pending") continue;
    if (item.kind === "user" || item.kind === "session") {
      // A steer ends the segment it joined; the turn goes on in a new one.
      const steered = item.kind === "user" && item.steer ? open : undefined;
      if (steered) steered.until = item.at;
      parts.push({ kind: "item", item });
      open = undefined;
      if (steered) {
        const turnId = steered.turnId ?? item.turn_id ?? undefined;
        open = {
          steer: true,
          started: item.at,
          members: [],
          ...(turnId && { turnId }),
        };
        parts.push(open);
      }
      continue;
    }
    const turnId = item.turn_id ?? undefined;
    if (open && turnId && open.turnId && open.turnId !== turnId)
      open = undefined;
    if (!open) {
      open = { steer: false, members: [], ...(turnId && { turnId }) };
      parts.push(open);
    }
    if (turnId && !open.turnId) open.turnId = turnId;
    open.members.push(item);
  }
  const last = lastOf(parts, (part) => !("kind" in part));
  const unconfirmedStop =
    chat.problem?.kind === "stop_unconfirmed" && !chat.problem.past;
  const live = chat.activity === "working" || chat.activity === "waiting";
  return parts.flatMap((part): TranscriptPart[] => {
    if ("kind" in part) return [part];
    if (part.members.length === 0) return [];
    const timing = part.turnId ? timings.get(part.turnId) : undefined;
    const active = timing ? timing.outcome === "active" : part === last && live;
    // A segment a steer ended folds while its turn goes on.
    const ongoing = active && !part.until;
    const unconfirmed = ongoing && unconfirmedStop;
    const { rows, steps } = rowsOf(
      part.members,
      !active ? "not_finished" : unconfirmedStop ? "unknown" : "running",
    );
    const marker = lastOf(
      part.members,
      (item): item is ItemOf<"marker"> =>
        item.kind === "marker" && item.reason !== "note",
    );
    const plan = lastOf(
      part.members,
      (item): item is ItemOf<"plan"> => item.kind === "plan",
    );
    const files = lastOf(
      part.members,
      (item): item is ItemOf<"files"> =>
        item.kind === "files" && item.state === "ended",
    );
    const commandEdits = steps.some(
      (step) =>
        Boolean(step.command) &&
        (step.kind === "edit" ||
          step.kind === "create" ||
          step.kind === "delete"),
    );
    // The final response is the last one, unless steps follow it.
    const lastWork = lastOf(
      rows,
      (row) => row.kind === "step" || row.kind === "response",
    );
    const final =
      !ongoing && lastWork?.kind === "response" ? lastWork.item : undefined;
    const started = time(part.steer ? part.started : timing?.started_at);
    const ended = unconfirmed
      ? now
      : time(part.until ?? timing?.ended_at ?? undefined);
    const outcome = part.until ? "completed" : (timing?.outcome ?? "completed");
    const words = unconfirmed
      ? TURN_WORDS.unconfirmed
      : outcome === "failed"
        ? TURN_WORDS.failed
        : outcome === "stopped" || outcome === "quit" || outcome === "lost"
          ? TURN_WORDS.stopped
          : part.steer
            ? TURN_WORDS.continued
            : TURN_WORDS.worked;
    const counts = PROBLEM_COUNTS.flatMap(([state, word]) => {
      // A count already said by the row's own outcome is not said again.
      if (state === "failed" && words === TURN_WORDS.failed) return [];
      if (state === "unknown" && unconfirmed) return [];
      const n = steps.filter((step) => step.state === state).length;
      return n ? [`${n} ${word}`] : [];
    });
    const span =
      started !== undefined && ended !== undefined && ended >= started
        ? `${words[0]} ${duration(ended - started)}`
        : words[1];
    return [
      {
        kind: "turn",
        turn: {
          key: part.members[0]?.id ?? "",
          live: ongoing && !unconfirmed,
          unconfirmed,
          label: [span, ...counts].join(" · "),
          rows: rows.filter(
            (row) => row.kind !== "response" || row.item !== final,
          ),
          ...(final && { final }),
          ...(marker && { marker }),
          ...(plan && planUnfinished(plan) && { plan }),
          ...(files && { files, commandEdits }),
          ids: part.members.map((item) => item.id),
        },
      },
    ];
  });
}

/**
 * The one polite status: a turn starting, waiting and ending, never each step.
 * Requests and stopping are said before it.
 */
export function turnStatus(
  chat: Pick<ChatState, "activity" | "problem">,
  items: TranscriptItem[],
) {
  if (chat.activity === "working") return "Working";
  if (chat.activity === "waiting") return "Waiting for you";
  const last = lastOf(turns(items, chat), (part) => part.kind === "turn");
  return last?.kind === "turn" ? last.turn.label : "";
}

/**
 * The first item that arrived after `seen`, the last one the reader had in view:
 * where the New marker goes. Your own messages never count, and neither do items
 * with no row of their own. Nothing is new without a seen position.
 */
export function firstNew(items: TranscriptItem[], seen: string | undefined) {
  const from = seen === undefined ? -1 : items.findIndex((i) => i.id === seen);
  if (from < 0) return undefined;
  return items
    .slice(from + 1)
    .find(
      (item) =>
        item.kind !== "user" &&
        item.kind !== "turn" &&
        !(item.kind === "request" && item.state === "pending"),
    )?.id;
}

/**
 * Where the New marker goes in a Chat the host says is unseen (#365: its last
 * ended turn came after the person last saw it) when this session has no seen
 * position of its own: the first item of that turn.
 */
export function unseenFrom(items: TranscriptItem[]) {
  const ended = lastOf(
    items,
    (item): item is ItemOf<"turn"> =>
      item.kind === "turn" && item.outcome !== "active",
  );
  if (!ended) return undefined;
  return items.find(
    (item) =>
      item.turn_id === ended.turn_id &&
      item.kind !== "user" &&
      item.kind !== "turn" &&
      !(item.kind === "request" && item.state === "pending"),
  )?.id;
}

/** What the agent did to a record, as the list row says it. */
export function changeLine(change: RecordChange) {
  if (change.kind === "status")
    return `Moved ${change.reference} to ${change.to}`;
  if (change.kind === "update")
    return `Posted an update on ${change.reference}`;
  return `Created the Document "${change.title}"`;
}

/** The host says the problem keeps the Chat from taking a new message. */
export const blocksSend = (problem: Problem | null | undefined) =>
  Boolean(problem?.blocks_send);

/** A managed folder is named by an id; it reads as the folder ticketd keeps. */
export const folderLabel = (folder: ChatState["folder"]) =>
  folder.managed ? "ticketd folder" : folder.name;

/** The header's context button, read aloud: what the popover holds. */
export function contextLabel(chat: ChatState) {
  const { folder } = chat;
  const branch = folder.branch?.name
    ? folder.branch.kind === "detached"
      ? `detached at ${folder.branch.name}`
      : `branch ${folder.branch.name}`
    : null;
  const others = folder.shared_with.length;
  return [
    `Folder ${folderLabel(folder)}`,
    folder.missing && "missing",
    branch,
    folder.project && `Project ${folder.project.title}`,
    others > 0 && `used by ${others} other ${others === 1 ? "Chat" : "Chats"}`,
  ]
    .filter(Boolean)
    .join(", ");
}

/** Waits for the person: approval, question, or a failure not yet seen. */
export const needsYou = (status: ChatStatus) =>
  status.rank === "approval" ||
  status.rank === "question" ||
  status.rank === "failed";

/** The row's one emphasis (title weight 500): it waits, or holds something unseen. */
export const emphasised = (status: ChatStatus) =>
  needsYou(status) || status.unseen;

/** A turn is in progress, so it can be stopped. */
export function isLive(chat: ChatState) {
  return chat.activity === "working" || chat.activity === "waiting";
}

/**
 * The composer's send button. Its word is set by the turn, never by what is
 * typed or by a request: `send` with no turn running (or to answer an open
 * question from the message box), `steer` while a turn runs that the harness
 * can steer, `queue` while one runs that it cannot.
 */
export type ComposerControls = {
  send: "send" | "steer" | "queue";
  /** Enter, or a click, does what the word says. */
  enabled: boolean;
  /** Cmd/Ctrl+Enter queues instead. Only while a turn runs. */
  queues?: boolean;
  /** What steering does, or why the message waits: the button's tooltip. */
  effect?: string;
};

/**
 * The send button for the turn's state and what is typed. `answering` is set
 * while the message box answers an open question.
 */
export function composerControls(
  chat: ChatState,
  text: string,
  answering = false,
): ComposerControls {
  const typed = text.trim() !== "";
  const blocked = blocksSend(chat.problem);
  if (!isLive(chat)) return { send: "send", enabled: typed && !blocked };
  // Stopping: Send waits for the turn to end; queueing stays possible.
  if (chat.stopping) return { send: "send", enabled: false, queues: typed };
  if (answering) return { send: "send", enabled: typed, queues: typed };
  if (!chat.steering.available)
    return {
      send: "queue",
      enabled: typed,
      queues: typed,
      effect: `${chat.harness.name} can't steer, so this waits for the turn to end.`,
    };
  return {
    send: "steer",
    enabled: typed && !blocked,
    queues: typed,
    ...(chat.steering.effect && { effect: chat.steering.effect }),
  };
}

/** A request item whose `state` is `pending`: it waits in the activity dock. */
export type PendingRequest = Extract<TranscriptItem, { kind: "request" }>;

/**
 * What a pending request is called: the host's title with what would run, or
 * the question itself. It names the request group and is what arrives in the
 * live announcement.
 */
export function requestLabel(request: PendingRequest) {
  if (request.request === "question") return request.subject || request.title;
  return request.subject
    ? `${request.title}: ${request.subject}`
    : request.title;
}

/** What the message box says it will do with what is typed. */
export function composerPlaceholder(chat: ChatState, answering: boolean) {
  const harness = chat.harness.name;
  if (!isLive(chat) || chat.stopping) return `Message ${harness}`;
  if (answering) return "Answer, or pick above";
  return chat.steering.available ? `Steer ${harness}` : `Queue for ${harness}`;
}

export type NoticeAction =
  | "check"
  | "copy-command"
  | "help"
  | "resend"
  | "discard"
  | "pick-folder"
  | "resume";

export type Notice = {
  tone: "neutral" | "error";
  title: string;
  /** Backticks mark a command or path to set in mono. */
  body: string;
  actions: NoticeAction[];
  /** The label of the `help` link. */
  help?: string;
};

/**
 * The notice for a problem. The host titles it; the body says what to do.
 * Wording for the states the design drew is the design's; the rest (spec
 * table 21.6) say what was observed as plainly.
 */
export function problemNotice(problem: Problem, harness: string): Notice {
  const said = problem.message ? ` ${problem.message}` : "";
  const signIn = problem.command ? `\`${problem.command}\`` : harness;
  // A failure of the last turn can be sent past; only a probe that can tell
  // whether it still holds is worth offering.
  const past = Boolean(problem.past);
  switch (problem.kind) {
    case "not_signed_in":
      if (past)
        return {
          tone: "neutral",
          title: problem.title,
          body: `The last turn stopped because ${harness} wasn't signed in. Run ${signIn} in a terminal and sign in, then check again or send your message. ticketd never asks for your password or keys.${said}`,
          actions: problem.command ? ["copy-command", "check"] : ["check"],
        };
      return {
        tone: "neutral",
        title: problem.title,
        body: `Run ${signIn} in a terminal and sign in, then check again. ticketd never asks for your password or keys.${said}`,
        actions: problem.command ? ["copy-command", "check"] : ["check"],
      };
    case "not_subscription":
      return {
        tone: "neutral",
        title: problem.title,
        body: `${problem.message ?? `${harness} is signed in with an API key or cloud provider.`} ticketd doesn't change how ${harness} signs in or bills. To use your subscription, run ${signIn} in a terminal, then check again.`,
        actions: problem.command ? ["copy-command", "check"] : ["check"],
      };
    case "sign_in_unknown":
      return {
        tone: "neutral",
        title: problem.title,
        body: `${problem.message ?? `${harness} says whether it is signed in when a Chat starts.`} If it isn't, run ${signIn} in a terminal. ticketd never asks for your password or keys.`,
        actions: problem.command ? ["copy-command", "check"] : ["check"],
      };
    case "not_installed":
      return {
        tone: "neutral",
        title: problem.title,
        body: `ticketd couldn't find ${harness} on this computer. Install it, then check again. What you typed is kept.`,
        actions: ["help", "check"],
        help: "Install guide",
      };
    case "incompatible":
      return {
        tone: "neutral",
        title: problem.title,
        body: `${problem.message ?? `ticketd needs a newer ${harness}.`} Update it, then check again. What you typed is kept.`,
        actions: ["help", "check"],
        help: "Update guide",
      };
    case "unavailable":
      return {
        tone: "neutral",
        title: problem.title,
        body: `${problem.message ?? `ticketd's part for ${harness} is missing.`} What you typed is kept.`,
        actions: ["check"],
      };
    case "probe_failed":
      return {
        tone: "neutral",
        title: problem.title,
        body: `It may still work.${said} Check again before sending.`,
        actions: ["check"],
      };
    case "usage_limit":
      return {
        tone: "neutral",
        title: problem.title,
        body: [
          problem.message,
          resetTime(problem.resets_at)
            ? `It says the limit resets ${resetTime(problem.resets_at)}.`
            : "It didn't say when the limit resets.",
          "Your work so far is kept. ticketd won't switch model or billing.",
          past &&
            "That is why the last turn stopped; you can send again once the limit has reset.",
        ]
          .filter(Boolean)
          .join(" "),
        actions: past ? [] : ["check"],
      };
    case "sandbox_unavailable":
      return {
        tone: "error",
        title: problem.title,
        body: `${past ? "The last turn stopped here. " : ""}${problem.message ?? "Its sandbox failed to start on this computer."} ticketd won't lower its permissions to continue.`,
        actions: past ? ["help"] : ["help", "check"],
        help: "Sandbox help",
      };
    case "uncertain_delivery":
      return {
        tone: "neutral",
        title: problem.title,
        // With a message, a resend the person asked for was not accepted.
        body: problem.message
          ? `${problem.message} ticketd still has no confirmation that ${harness} received the first attempt; it may have started work. Sending it again sends only this message; discarding keeps it here, marked as not confirmed.`
          : `ticketd has no confirmation that ${harness} received it. It may have started work. It hasn't been sent again. Sending it again sends only this message; discarding keeps it here, marked as not confirmed.`,
        actions: ["resend", "discard"],
      };
    case "folder_missing":
      return {
        tone: "neutral",
        title: problem.title,
        body: `${problem.path ? `\`${problem.path}\`` : "The folder"} wasn't found. Nothing was re-run. Put it back and check again, or pick another folder to keep going here.`,
        actions: ["check", "pick-folder"],
      };
    case "history_lost":
      return {
        tone: "neutral",
        title: problem.title,
        body: "You can still read it here. To keep going, resume in a fresh session and choose which history to give it.",
        actions: ["resume"],
      };
    case "session_in_use":
      if (past)
        return {
          tone: "neutral",
          title: problem.title,
          body: `The last turn stopped because of that. Close it there before you send again.${said}`,
          actions: [],
        };
      return {
        tone: "neutral",
        title: problem.title,
        body: `Close it there, then check again. Nothing was sent.${said}`,
        actions: ["check"],
      };
    case "stop_unconfirmed":
      // Stop stays enabled as the retry, so the notice offers nothing else.
      return {
        tone: "neutral",
        title: problem.title,
        body: `${harness} may still be running.`,
        actions: [],
      };
    case "failed":
      return {
        tone: "error",
        title: problem.title,
        body: `${problem.message ?? "It gave no reason."} What it finished before that is kept; the turn is not complete.`,
        actions: ["check"],
      };
  }
}

/** "on Nov 12 at 3:00 PM", local time, from seconds since the epoch; "" when there is none. */
function resetTime(seconds: number | null | undefined): string {
  if (seconds == null) return "";
  const at = new Date(seconds * 1000);
  if (Number.isNaN(at.getTime())) return "";
  const day = at.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  const time = at.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  return `on ${day} at ${time}`;
}

/** "now", "2m", "1h", "Yesterday", "Nov 8": the trailing time of a Chat row. */
export function chatTime(timestamp: string, now = Date.now()): string {
  const then = new Date(timestamp);
  if (Number.isNaN(then.getTime())) return "";
  const minutes = Math.max(0, Math.floor((now - then.getTime()) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (new Date(now).toDateString() === then.toDateString())
    return `${Math.floor(minutes / 60)}h`;
  if (new Date(now - 86_400_000).toDateString() === then.toDateString())
    return "Yesterday";
  return then.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** KiB or MiB to one decimal, as the truncation note states sizes. */
export function binarySize(bytes: number): string {
  const mib = bytes / 1_048_576;
  const text = (value: number) => String(Math.round(value * 10) / 10);
  return mib >= 1 ? `${text(mib)} MiB` : `${text(bytes / 1024)} KiB`;
}

/** "1 Chat", "2 Chats". */
export const chatCount = (n: number) => count(n, "Chat");

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
/** Terminal colour, cursor and title codes, which a step's output box does not draw. */
const ANSI = new RegExp(
  `${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`,
  "g",
);

/** A step's output as plain text: ANSI colour is stripped. */
export const plainOutput = (output: string) => output.replace(ANSI, "");
