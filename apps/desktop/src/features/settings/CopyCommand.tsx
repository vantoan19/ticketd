import { Button } from "@/components/ui/button";
import { useCopy } from "@/components/ui/use-copy";

/** A labelled button that copies a command, so the fix is never an unlabelled icon. */
export function CopyCommand({
  command,
  agent,
}: {
  command: string;
  agent: string;
}) {
  const { copied, error, copy } = useCopy();
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={`Copy command for ${agent}`}
        onClick={() => void copy("command", command)}
      >
        {copied ? "Copied" : "Copy command"}
      </Button>
      <span className="sr-only" role="status">
        {error}
      </span>
    </>
  );
}
