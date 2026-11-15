import type { ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
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
}) {
  const { copied, error, copy } = useCopy();
  // The tooltip keeps the short label; the name tells rows apart.
  const name: object = subject ? { "aria-label": `${label} ${subject}` } : {};
  return (
    <>
      <IconButton
        type="button"
        label={copied ? "Copied" : error ? "Copy unavailable" : label}
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
