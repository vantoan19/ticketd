import { cn } from "cn";

/** `ready`, `blocked` and `unread` are ticket status vocabulary. Use `positive`
 * and `attention` for other good and needs-attention states, such as an active
 * Plan or the command-line check. */
export type StatusDotTone =
  | "ready"
  | "blocked"
  | "unread"
  | "checked"
  | "neutral"
  | "positive"
  | "attention";

const TONE_COLOR: Record<StatusDotTone, string> = {
  ready: "bg-status-ready",
  checked: "bg-status-checked",
  blocked: "bg-status-blocked",
  unread: "bg-status-unread",
  neutral: "bg-status-neutral",
  positive: "bg-status-ready",
  attention: "bg-status-blocked",
};

/** A small colored dot. Always place it beside a word; color alone carries no meaning. */
export function StatusDot({
  tone,
  size = 8,
  className,
}: {
  tone: StatusDotTone;
  size?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-slot="status-dot"
      data-tone={tone}
      className={cn(
        "inline-block shrink-0 rounded-full",
        TONE_COLOR[tone],
        className,
      )}
      style={{ width: size, height: size }}
    />
  );
}
