import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCopy } from "@/components/ui/use-copy";

/**
 * Copies text and says so beside the button, or says copying is unavailable.
 * `aria-label` names what is copied, such as "Copy checkout path /work/app".
 */
export function CopyButton({
  text,
  "aria-label": ariaLabel,
}: {
  text: string;
  "aria-label": string;
}) {
  const { copied, error, copy } = useCopy();
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={ariaLabel}
        onClick={() => void copy("text", text)}
      >
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        Copy
      </Button>
      <span className="settings-hint" role="status">
        {copied && "Copied"}
        {error && "Copy unavailable. Select the text."}
      </span>
    </>
  );
}
