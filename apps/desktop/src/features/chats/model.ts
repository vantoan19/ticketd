import type {
  ChatChange,
  ChatSnapshot,
  ChatState,
  ChatSummary,
  Problem,
  ProblemKind,
  RecordChange,
  Step,
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

/** "Read 6 files, edited 2 files, ran 1 command" for a run of finished steps. */
export function stepTally(steps: Pick<Step, "verb" | "target" | "more">[]) {
  const total = (verb: Step["verb"]) =>
    steps
      .filter((step) => step.verb === verb)
      .reduce((sum, step) => sum + 1 + step.more, 0);
  const parts = [
    total("read") && `read ${count(total("read"), "file")}`,
    total("edited") && `edited ${count(total("edited"), "file")}`,
    total("ran") && `ran ${count(total("ran"), "command")}`,
    total("other") && count(total("other"), "other step"),
  ].filter((part): part is string => Boolean(part));
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What the agent did to a record, as the list row says it. */
export function changeLine(change: RecordChange) {
  if (change.kind === "status")
    return `Moved ${change.reference} to ${change.to}`;
  if (change.kind === "update")
    return `Posted an update on ${change.reference}`;
  return `Created the Document "${change.title}"`;
}

const PROBLEM_LINES: Record<ProblemKind, string> = {
  not_installed: "Not sent",
  incompatible: "Not sent",
  probe_failed: "Not sent",
  not_signed_in: "Not sent",
  usage_limit: "Stopped: usage limit reached",
  sandbox_unavailable: "Stopped: sandbox unavailable",
  capability_unavailable: "Stopped: a capability is unavailable",
  uncertain_delivery: "Needs your decision",
  folder_missing: "Folder missing",
  history_lost: "Session unavailable",
  session_in_use: "Session in use elsewhere",
  stop_unconfirmed: "Stop not confirmed",
  failed: "Failed",
};

/** The second line of a Chat's list row. */
export function summaryLine(chat: ChatSummary): string {
  if (chat.problem) return PROBLEM_LINES[chat.problem];
  if (chat.activity === "waiting") return "Waiting for you";
  if (chat.activity === "working") return "Working…";
  if (chat.activity === "failed") return "Failed";
  if (chat.activity === "interrupted")
    return chat.interruption === "stopped"
      ? "You stopped this turn"
      : chat.interruption === "quit"
        ? "Stopped when ticketd quit"
        : chat.interruption === "unconfirmed"
          ? "Stop not confirmed"
          : "Interrupted";
  if (chat.last_change) return changeLine(chat.last_change);
  return chat.preview || "Idle";
}

/** Problems that keep the Chat from taking a new message until they are resolved. */
const BLOCKING: ProblemKind[] = [
  "not_installed",
  "incompatible",
  "not_signed_in",
  "usage_limit",
  "sandbox_unavailable",
  "uncertain_delivery",
  "session_in_use",
];
/** Problems under which there is nothing to type into. */
const NO_COMPOSER: ProblemKind[] = ["folder_missing", "history_lost"];

export function hasComposer(chat: ChatState) {
  return (
    chat.retention !== "trashed" &&
    !(chat.problem && NO_COMPOSER.includes(chat.problem.kind))
  );
}

/** Problems that are an install or sign-in step: shown on the row, never counted. */
const SETUP: ProblemKind[] = [
  "not_installed",
  "incompatible",
  "probe_failed",
  "not_signed_in",
];

/**
 * Whether a Chat counts in the sidebar: it waits for an answer, its delivery
 * is uncertain, or it Failed. The host computes the same rule for its rows.
 */
export function needsYou(
  activity: ChatState["activity"],
  problem: ProblemKind | undefined,
) {
  if (activity === "waiting" || problem === "uncertain_delivery") return true;
  if (problem && SETUP.includes(problem)) return false;
  return activity === "failed" || problem === "failed";
}

/** A turn is in progress, so it can be stopped. */
export function isLive(chat: ChatState) {
  return chat.activity === "working" || chat.activity === "waiting";
}

export type ComposerControls =
  | { kind: "send"; enabled: boolean }
  /** Nothing typed during a turn: Stop is the only button. */
  | { kind: "stop" }
  | { kind: "steer"; hint: string }
  | { kind: "queue-only"; hint: string };

/** Which buttons the composer shows for the turn's state and what is typed. */
export function composerControls(
  chat: ChatState,
  text: string,
): ComposerControls {
  const typed = text.trim() !== "";
  if (!isLive(chat))
    return {
      kind: "send",
      enabled: typed && !(chat.problem && BLOCKING.includes(chat.problem.kind)),
    };
  if (!typed) return { kind: "stop" };
  if (!chat.steering.available)
    return {
      kind: "queue-only",
      hint: `${chat.harness.name} can't take messages mid-turn. This will be queued until the turn ends.`,
    };
  return {
    kind: "steer",
    hint: [
      "Send adds this to the turn in progress.",
      chat.steering.effect,
      "Queue holds it until the turn ends.",
    ]
      .filter(Boolean)
      .join(" "),
  };
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
 * The notice for a problem. Wording for the states the design drew is the
 * design's; the rest (spec table 20.6) say what was observed as plainly.
 */
export function problemNotice(problem: Problem, harness: string): Notice {
  const said = problem.message ? ` ${problem.message}` : "";
  switch (problem.kind) {
    case "not_signed_in":
      return {
        tone: "neutral",
        title: `${harness} isn't signed in`,
        body: `Run ${problem.command ? `\`${problem.command}\`` : harness} in a terminal and sign in, then check again. ticketd never asks for your password or keys.${said}`,
        actions: problem.command ? ["copy-command", "check"] : ["check"],
      };
    case "not_installed":
      return {
        tone: "neutral",
        title: `${harness} isn't installed`,
        body: `ticketd couldn't find ${harness} on this computer. Install it, then check again. What you typed is kept.`,
        actions: ["help", "check"],
        help: "Install guide",
      };
    case "incompatible":
      return {
        tone: "neutral",
        title: `This ${harness} version can't be used`,
        body: `${problem.message ?? `ticketd needs a newer ${harness}.`} Update it, then check again. What you typed is kept.`,
        actions: ["help", "check"],
        help: "Update guide",
      };
    case "probe_failed":
      return {
        tone: "neutral",
        title: `ticketd couldn't check ${harness}`,
        body: `It may still work.${said} Check again before sending.`,
        actions: ["check"],
      };
    case "usage_limit":
      return {
        tone: "neutral",
        title: `${harness} reached your usage limit`,
        body: `${problem.resets ? `It says the limit resets ${problem.resets}.` : "It didn't say when the limit resets."} Your work so far is kept. ticketd won't switch model or billing.`,
        actions: ["check"],
      };
    case "sandbox_unavailable":
      return {
        tone: "error",
        title: `${harness} can't run commands here`,
        body: `${problem.message ?? "Its sandbox failed to start on this computer."} ticketd won't lower its permissions to continue.`,
        actions: ["help", "check"],
        help: "Sandbox help",
      };
    case "capability_unavailable":
      return {
        tone: "neutral",
        title: `Something ${harness} uses isn't available`,
        body: `${problem.message ?? ""} ticketd won't substitute another model or provider. Other work can continue.`.trim(),
        actions: ["check"],
      };
    case "uncertain_delivery":
      return {
        tone: "neutral",
        title: `Did ${harness} get your last message?`,
        body: `The connection dropped right after it was sent. It may have started work. It hasn't been sent again.${said}`,
        actions: ["resend", "discard"],
      };
    case "folder_missing":
      return {
        tone: "neutral",
        title: "This Chat's folder is missing",
        body: `${problem.path ? `\`${problem.path}\`` : "The folder"} wasn't found after the restore. Nothing was re-run.`,
        actions: ["pick-folder"],
      };
    case "history_lost":
      return {
        tone: "neutral",
        title: `${harness} no longer has this conversation`,
        body: "You can still read it here. To keep going, resume in a fresh session and choose which history to give it.",
        actions: ["resume"],
      };
    case "session_in_use":
      return {
        tone: "neutral",
        title: `This ${harness} session is open somewhere else`,
        body: `Close it there, then check again. Nothing was sent.${said}`,
        actions: ["check"],
      };
    case "stop_unconfirmed":
      return {
        tone: "neutral",
        title: `${harness} didn't confirm it stopped`,
        body: `ticketd asked it to stop and heard nothing back. It may still be running. Edits already made are kept.${said}`,
        actions: ["check"],
      };
    case "failed":
      return {
        tone: "error",
        title: `${harness} stopped with an error`,
        body: `${problem.message ?? "It gave no reason."} What it finished before that is kept; the turn is not complete.`,
        actions: ["check"],
      };
  }
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

/** "12s", "2m 14s": how long the current step has run. */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** KiB or MiB to one decimal, as the truncation note states sizes. */
export function binarySize(bytes: number): string {
  const mib = bytes / 1_048_576;
  const text = (value: number) => String(Math.round(value * 10) / 10);
  return mib >= 1 ? `${text(mib)} MiB` : `${text(bytes / 1024)} KiB`;
}

/** "1 Chat", "2 Chats". */
export const chatCount = (n: number) => count(n, "Chat");
