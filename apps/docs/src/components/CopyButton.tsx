import { buttonVariants } from "fumadocs-ui/components/ui/button";
import { Check, Clipboard, Copy, Link, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { useHydrated } from "./useHydrated";

const actions = {
  article: {
    icon: Copy,
    label: "Copy Markdown",
    success: "Copied Markdown",
    fallback: "Open Read as Markdown to copy the article manually.",
  },
  code: {
    icon: Clipboard,
    label: "Copy Text",
    success: "Copied Text",
    fallback: "Select the code to copy it manually.",
  },
  heading: {
    icon: Link,
    label: "Copy Anchor Link",
    success: "Copied Anchor Link",
    fallback: "Use the heading link to get its address.",
  },
} as const;

type CopyState = "ready" | "copying" | "copied" | "failed";

export function CopyButton({
  action,
  read,
}: {
  action: keyof typeof actions;
  read: () => string | Promise<string>;
}) {
  const hydrated = useHydrated();
  const [state, setState] = useState<CopyState>("ready");
  useEffect(() => {
    if (state !== "copied") return;
    const reset = window.setTimeout(() => setState("ready"), 1500);
    return () => window.clearTimeout(reset);
  }, [state]);
  if (hydrated && !navigator.clipboard) return null;
  const { icon, label, success, fallback } = actions[action];
  const Icon =
    state === "copied" ? Check : state === "failed" ? RotateCcw : icon;
  const message = {
    ready: label,
    copying: "Copying…",
    copied: success,
    failed: "Retry copy",
  }[state];
  const compact = action !== "article";

  async function copy() {
    if (state === "copying") return;
    setState("copying");
    try {
      const clipboard = navigator.clipboard,
        content = read();
      if (typeof content === "string") await clipboard.writeText(content);
      else if (typeof ClipboardItem === "function" && clipboard.write) {
        // Safari needs the clipboard request inside the original key or tap
        // event. The item can receive its text when the article finishes loading.
        const data = content.then(
          (text) => new Blob([text], { type: "text/plain" }),
        );
        await Promise.all([
          data,
          clipboard.write([new ClipboardItem({ "text/plain": data })]),
        ]);
      } else await clipboard.writeText(await content);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <button
      type="button"
      className={buttonVariants({
        variant: compact ? "ghost" : "secondary",
        size: compact ? "icon-xs" : "sm",
        className: "doc-copy-" + action,
      })}
      aria-live="polite"
      aria-disabled={state === "copying" || undefined}
      title={state === "failed" ? fallback : compact ? label : undefined}
      onClick={copy}
    >
      <Icon aria-hidden="true" size={14} />
      <span className={compact ? "sr-only" : undefined}>{message}</span>
    </button>
  );
}
