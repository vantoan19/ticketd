import type { ComponentProps, ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import {
  ariaKeyShortcuts,
  shortcutLabel,
  type ShortcutId,
} from "@/lib/shortcuts";
import { useCopy } from "@/components/ui/use-copy";

/**
 * Copies `text`. The icon turns into a check for 2s and the tooltip reads
 * "Copied"; a failure shows in the tooltip. `label` names what is copied
 * ("Copy path", never the path itself). `icon` replaces the copy glyph where
 * another names the thing better (a link for "Copy link"). Menu items that
 * copy post to the status line instead.
 */
export function CopyButton({
  text,
  label,
  subject,
  icon,
  className,
  shortcutId,
  size = "icon-sm",
  onMouseDown,
}: {
  text: string;
  label: string;
  /**
   * What is copied, added to the accessible name only ("Copy path
   * /work/app"), so several buttons in a list stay distinct.
   */
  subject?: string;
  icon?: ReactNode;
  className?: string;
  /** The registered action, only for a copy that actually owns this key. */
  shortcutId?: ShortcutId;
  size?: ComponentProps<typeof IconButton>["size"];
  onMouseDown?: ComponentProps<typeof IconButton>["onMouseDown"];
}) {
  const { copied, error, copy } = useCopy();
  // The tooltip keeps the short label; the name tells rows apart.
  const name: object = subject ? { "aria-label": `${label} ${subject}` } : {};
  return (
    <>
      <IconButton
        type="button"
        size={size}
        onMouseDown={onMouseDown}
        label={copied ? "Copied" : error ? "Copy unavailable" : label}
        {...(shortcutId && {
          "aria-keyshortcuts": ariaKeyShortcuts(shortcutId),
          ...(!copied && !error && { shortcut: shortcutLabel(shortcutId) }),
        })}
        {...name}
        data-copied={copied ? "" : undefined}
        {...(className && { className })}
        // useCopy names what is copied ("path"), not the button ("Copy
        // path"), so a failure reads "Couldn't copy path: …".
        onClick={() => void copy(label.replace(/^copy\s+/i, ""), text)}
      >
        {copied ? <Check /> : (icon ?? <Copy />)}
      </IconButton>
      <span className="sr-only" role="status">
        {copied ? "Copied" : error}
      </span>
    </>
  );
}
