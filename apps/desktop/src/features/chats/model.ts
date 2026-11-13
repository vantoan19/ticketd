import type {
  ChatChange,
  ChatSnapshot,
  ChatState,
  ChatStatus,
  HarnessStatus,
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

/**
 * "Read 6 files, edited 2 files, ran 1 command" for the finished steps; a step still
 * running, or one that failed, was refused or lost, is never told as done.
 */
export function stepTally(
  steps: Pick<Step, "verb" | "target" | "more" | "state">[],
) {
  const sum = (picked: typeof steps) =>
    picked.reduce((total, step) => total + 1 + step.more, 0);
  const done = steps.filter((step) => (step.state ?? "done") === "done");
  const total = (verb: Step["verb"]) =>
    sum(done.filter((step) => step.verb === verb));
  const running = sum(steps.filter((step) => step.state === "running"));
  const unfinished = sum(
    steps.filter((step) => step.state === "failed" || step.state === "unknown"),
  );
  const parts = [
    total("read") && `read ${count(total("read"), "file")}`,
    total("edited") && `edited ${count(total("edited"), "file")}`,
    total("ran") && `ran ${count(total("ran"), "command")}`,
    total("other") && count(total("other"), "other step"),
    running && `${count(running, "step")} in progress`,
    unfinished && `${count(unfinished, "step")} did not complete`,
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

/**
 * Problems that keep the Chat from taking a new message until they are resolved.
 * Only one observed now blocks; why the last turn stopped (`past`) never does.
 */
const BLOCKING: ProblemKind[] = [
  "not_installed",
  "incompatible",
  "unavailable",
  "not_signed_in",
  "usage_limit",
  "sandbox_unavailable",
  "uncertain_delivery",
  "session_in_use",
];
/** Problems under which there is nothing to type into. */
const NO_COMPOSER: ProblemKind[] = ["folder_missing", "history_lost"];

export function blocksSend(problem: Problem | null | undefined) {
  return Boolean(problem && !problem.past && BLOCKING.includes(problem.kind));
}

export function hasComposer(chat: ChatState) {
  const problem = chat.problem;
  return (
    chat.retention !== "trashed" &&
    !(problem && !problem.past && NO_COMPOSER.includes(problem.kind))
  );
}

/**
 * Whether a Chat can be started on a harness with this status. A sign-in that is
 * not a subscription, or that ticketd could not check, does not block: it is shown.
 */
export function harnessUsable(status: HarnessStatus["status"]) {
  return (
    status === "ready" ||
    status === "not_subscription" ||
    status === "sign_in_unknown"
  );
}

/** Waits for the person: approval, question, or a failure not yet seen. */
export const waits = (status: ChatStatus) =>
  status.rank === "approval" ||
  status.rank === "question" ||
  status.rank === "failed";

/** The row's one emphasis (title weight 500): it waits, or holds something unseen. */
export const emphasised = (status: ChatStatus) =>
  waits(status) || status.unseen;

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
      enabled: typed && !blocksSend(chat.problem),
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
 * design's; the rest (spec table 21.6) say what was observed as plainly.
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
          title: `${harness} wasn't signed in`,
          body: `The last turn stopped because ${harness} wasn't signed in. Run ${signIn} in a terminal and sign in, then check again or send your message. ticketd never asks for your password or keys.${said}`,
          actions: problem.command ? ["copy-command", "check"] : ["check"],
        };
      return {
        tone: "neutral",
        title: `${harness} isn't signed in`,
        body: `Run ${signIn} in a terminal and sign in, then check again. ticketd never asks for your password or keys.${said}`,
        actions: problem.command ? ["copy-command", "check"] : ["check"],
      };
    case "not_subscription":
      return {
        tone: "neutral",
        title: `${harness} isn't using a subscription`,
        body: `${problem.message ?? `${harness} is signed in with an API key or cloud provider.`} ticketd doesn't change how ${harness} signs in or bills. To use your subscription, run ${signIn} in a terminal, then check again.`,
        actions: problem.command ? ["copy-command", "check"] : ["check"],
      };
    case "sign_in_unknown":
      return {
        tone: "neutral",
        title: `ticketd can't check ${harness}'s sign-in`,
        body: `${problem.message ?? `${harness} says whether it is signed in when a Chat starts.`} If it isn't, run ${signIn} in a terminal. ticketd never asks for your password or keys.`,
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
    case "unavailable":
      return {
        tone: "neutral",
        title: `${harness} isn't available`,
        body: `${problem.message ?? `ticketd's part for ${harness} is missing.`} What you typed is kept.`,
        actions: ["check"],
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
        title: `${harness} can't run commands here`,
        body: `${past ? "The last turn stopped here. " : ""}${problem.message ?? "Its sandbox failed to start on this computer."} ticketd won't lower its permissions to continue.`,
        actions: past ? ["help"] : ["help", "check"],
        help: "Sandbox help",
      };
    case "uncertain_delivery":
      return {
        tone: "neutral",
        title: `Did ${harness} get your message?`,
        // With a message, a resend the person asked for was not accepted.
        body: problem.message
          ? `${problem.message} ticketd still has no confirmation that ${harness} received the first attempt; it may have started work. Sending it again sends only this message; discarding keeps it here, marked as not confirmed.`
          : `ticketd has no confirmation that ${harness} received it. It may have started work. It hasn't been sent again. Sending it again sends only this message; discarding keeps it here, marked as not confirmed.`,
        actions: ["resend", "discard"],
      };
    case "folder_missing":
      return {
        tone: "neutral",
        title: "This Chat's folder is missing",
        body: `${problem.path ? `\`${problem.path}\`` : "The folder"} wasn't found. Nothing was re-run. Put it back and check again, or pick another folder to keep going here.`,
        actions: ["check", "pick-folder"],
      };
    case "history_lost":
      return {
        tone: "neutral",
        title: `${harness} no longer has this conversation`,
        body: "You can still read it here. To keep going, resume in a fresh session and choose which history to give it.",
        actions: ["resume"],
      };
    case "session_in_use":
      if (past)
        return {
          tone: "neutral",
          title: `This ${harness} session was open somewhere else`,
          body: `The last turn stopped because of that. Close it there before you send again.${said}`,
          actions: [],
        };
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
