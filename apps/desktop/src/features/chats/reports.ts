import type {
  ChangedFile,
  ContextUsage,
  PlanStep,
  TranscriptItem,
  ItemOf,
} from "@/features/chats/client";
import { duration, reasoningShown } from "@/features/chats/model";

export { reasoningShown };

/**
 * How the views of #367 word what the host reported about a turn's reasoning,
 * plan and files, and the session's context window. Nothing here estimates:
 * a value the harness did not report is left out.
 */

/** "12s", "2m 13s"; `null` below one second, which is never said as "0s". */
function reportedTime(ms: number | null | undefined): string | null {
  if (ms == null || ms < 1000) return null;
  return duration(ms);
}

export type ReasoningWords = {
  /** The row's words, without the live clock. */
  text: string;
  /** The outcome word, shown in the foreground at weight 500. */
  outcome?: "Not finished" | "Not confirmed";
  /** The accessible name of the row's button. */
  label: string;
};

/** A finished row: "Thought for 12s", or "Thought" without a time. */
export function reasoningWords(item: ItemOf<"reasoning">): ReasoningWords {
  if (item.state === "running") {
    const text = item.heading ? `Thinking · ${item.heading}` : "Thinking…";
    return { text, label: `Show reasoning, ${text}` };
  }
  const took =
    item.started_at != null && item.ended_at != null
      ? reportedTime(item.ended_at - item.started_at)
      : null;
  const text = took ? `Thought for ${took}` : "Thought";
  const outcome =
    item.state === "not_finished"
      ? "Not finished"
      : item.state === "unknown"
        ? "Not confirmed"
        : undefined;
  const spoken = took
    ? `thought for ${took.replace(/(\d+)m/, "$1 minutes").replace(/(\d+)s/, "$1 seconds")}`
    : "thought";
  return {
    text,
    ...(outcome && { outcome }),
    label: `Show reasoning, ${spoken}${outcome ? `, ${outcome.toLowerCase()}` : ""}`,
  };
}

export function planCount(steps: PlanStep[]) {
  const done = steps.filter((step) => step.status === "completed").length;
  return { done, total: steps.length, text: `${done} of ${steps.length} done` };
}

/** The step running now, in the harness's words for it. */
export function currentStep(steps: PlanStep[]): string | undefined {
  const now = steps.find((step) => step.status === "in_progress");
  return now ? (now.active_label ?? now.text) : undefined;
}

/** "3 files changed · +53 −7 · 1 not confirmed". Unconfirmed edits stay out of the totals. */
export function filesSummary(files: ChangedFile[]) {
  const confirmed = files.filter((file) => file.confirmed);
  const counted = confirmed.filter(
    (file) => file.added_lines != null && file.removed_lines != null,
  );
  const added = counted.reduce((sum, file) => sum + (file.added_lines ?? 0), 0);
  const removed = counted.reduce(
    (sum, file) => sum + (file.removed_lines ?? 0),
    0,
  );
  const unconfirmed = files.length - confirmed.length;
  return {
    text: `${files.length} ${files.length === 1 ? "file" : "files"} changed`,
    counts: counted.length > 0 ? `+${added} −${removed}` : null,
    unconfirmed: unconfirmed > 0 ? `${unconfirmed} not confirmed` : null,
  };
}

export const fileCounts = (file: ChangedFile) =>
  file.added_lines != null && file.removed_lines != null
    ? `+${file.added_lines} −${file.removed_lines}`
    : "—";

export function fileKind(file: ChangedFile): string | null {
  switch (file.kind) {
    case "added":
      return "new";
    case "deleted":
      return "deleted";
    case "renamed":
      return "renamed";
    case "modified":
      return null;
  }
}

/** "Open src/auth/limiter.ts in your editor, new file, 48 lines added". */
export function fileLabel(file: ChangedFile): string {
  const parts = [`Open ${file.path} in your editor`];
  const kind = fileKind(file);
  if (kind) parts.push(`${kind} file`);
  if (!file.confirmed) parts.push("not confirmed");
  if (file.added_lines) parts.push(`${file.added_lines} lines added`);
  if (file.removed_lines) parts.push(`${file.removed_lines} lines removed`);
  return parts.join(", ");
}

/** A long path shortened in the shortenedPath, keeping its file name whole. */
export function shortenedPath(path: string, max = 48): string {
  if (path.length <= max) return path;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const keep = Math.max(max - name.length - 1, 8);
  return `${path.slice(0, keep)}…/${name}`;
}

/** "124k", "1.2M"; small counts as they are. */
export function tokens(count: number): string {
  if (count >= 1_000_000)
    return `${Math.round(count / 100_000) / 10}M`.replace(".0M", "M");
  if (count >= 1000) return `${Math.round(count / 1000)}k`;
  return String(count);
}

/** A category's size: one decimal below 100k ("3.2k", "0.3k"), so sizes compare. */
export function preciseTokens(count: number): string {
  if (count >= 100_000) return tokens(count);
  return `${(count / 1000).toFixed(1)}k`;
}

/** When the person's last message was sent: a context report older than it says when it is from. */
export function lastAsk(items: TranscriptItem[]): string | undefined {
  return [...items].reverse().find((item) => item.kind === "user")?.at;
}

export function contextWords(context: ContextUsage) {
  const percent = Math.min(
    100,
    Math.round((context.used / Math.max(context.window, 1)) * 100),
  );
  return {
    percent,
    /** From 80% the count says the share, with the attention dot. */
    full: percent >= 80,
    label: `Context window: ${percent}% used, ${tokens(context.used)} of ${tokens(context.window)} tokens`,
    headline: `Context ${tokens(context.used)} of ${tokens(context.window)}`,
  };
}

export const clockTime = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

/** The plan of the turn in progress, for the dock's pill. */
export function runningPlan(
  items: TranscriptItem[],
): ItemOf<"plan"> | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "plan")
      return item.state === "running" ? item : undefined;
  }
  return undefined;
}
