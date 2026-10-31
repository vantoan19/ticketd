import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Copies text and says so beside the button, or says copying is unavailable. */
export function CopyButton({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "unavailable">(
    "idle",
  );
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`Copy ${label}`}
        onClick={() =>
          void navigator.clipboard.writeText(text).then(
            () => setCopied("copied"),
            () => setCopied("unavailable"),
          )
        }
      >
        {copied === "copied" ? <Check aria-hidden /> : <Copy aria-hidden />}
        Copy
      </Button>
      <span className="settings-hint" role="status">
        {copied === "copied" && "Copied"}
        {copied === "unavailable" && "Copy unavailable. Select the text."}
      </span>
    </>
  );
}
