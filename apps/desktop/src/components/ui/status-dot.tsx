import { cn } from "cn";

/** `ready`, `blocked` and `unread` are ticket status vocabulary. Use `positive`
 * and `attention` for other good and needs-attention states, such as an active
 * Effort or the command-line check. */
export type StatusDotTone =
  | "ready"
  | "blocked"
  | "unread"
  | "checked"
  | "neutral"
  | "positive"
  | "attention";

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
        "inline-block shrink-0 rounded-full bg-(--status-dot-color) data-[tone=ready]:[--status-dot-color:var(--status-ready)] data-[tone=checked]:[--status-dot-color:var(--status-checked)] data-[tone=blocked]:[--status-dot-color:var(--status-blocked)] data-[tone=unread]:[--status-dot-color:var(--status-unread)] data-[tone=neutral]:[--status-dot-color:var(--status-neutral)] data-[tone=positive]:[--status-dot-color:var(--status-ready)] data-[tone=attention]:[--status-dot-color:var(--status-blocked)]",
        className,
      )}
      style={{ width: size, height: size }}
    />
  );
}
