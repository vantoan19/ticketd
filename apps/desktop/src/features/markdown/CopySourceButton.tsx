import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Copies Markdown or code. `compact` shows only an icon; the label stays as its accessible name and tooltip. */
export function CopySourceButton({
  source,
  label,
  compact = false,
}: {
  source: string;
  label: string;
  compact?: boolean;
}) {
  const [message, setMessage] = useState("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(source);
      setMessage("Copied");
    } catch {
      setMessage("Copy unavailable. Select and copy the source instead.");
    }
  }
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size={compact ? "icon-sm" : "sm"}
        {...(compact ? { "aria-label": label, title: label } : {})}
        onClick={() => void copy()}
      >
        {compact ? message === "Copied" ? <Check /> : <Copy /> : label}
      </Button>
      <span role="status" className="text-muted-foreground text-xs">
        {compact && message === "Copied" ? "" : message}
      </span>
    </>
  );
}
