import { Check, Copy } from "lucide-react";
import { cn } from "cn";
import { IconButton } from "./icon-button";
import { useCopy } from "./use-copy";

/** ALL_CAPS words of three or more characters, such as PATH or PROJECT_ID. */
const PLACEHOLDER = /\b[A-Z][A-Z0-9_]{2,}\b/g;

function parts(command: string) {
  const out: { text: string; placeholder: boolean }[] = [];
  let last = 0;
  for (const match of command.matchAll(PLACEHOLDER)) {
    if (match.index > last)
      out.push({ text: command.slice(last, match.index), placeholder: false });
    out.push({ text: match[0], placeholder: true });
    last = match.index + match[0].length;
  }
  if (last < command.length)
    out.push({ text: command.slice(last), placeholder: false });
  return out;
}

/**
 * A command to run in a terminal, in a recessed mono block with a muted `$`
 * prompt that is neither selectable nor copied. ALL_CAPS words (PATH, TICKET,
 * FOLDER) are placeholders shown in the keyword color; say so near the block.
 * The icon button copies `command` and a status says "Copied". `copyLabel` is
 * its accessible name, such as "Copy the export command".
 */
export function CommandBlock({
  command,
  copyLabel,
  className,
}: {
  command: string;
  copyLabel: string;
  className?: string;
}) {
  const { copied, error, copy } = useCopy();
  return (
    <div
      data-slot="command-block"
      className={cn(
        "flex min-h-10 min-w-0 items-center gap-2 rounded-(--radius) bg-(--recessed) py-1 pr-1 pl-3",
        className,
      )}
    >
      <code className="min-w-0 flex-1 overflow-x-auto font-mono text-(length:--text-code) leading-5 whitespace-nowrap">
        <span
          aria-hidden="true"
          className="text-(--disabled-foreground) select-none"
        >
          {"$ "}
        </span>
        {parts(command).map((part, index) =>
          part.placeholder ? (
            <span
              key={index}
              data-placeholder
              className="text-(--syntax-keyword)"
            >
              {part.text}
            </span>
          ) : (
            part.text
          ),
        )}
      </code>
      <span
        role="status"
        className="shrink-0 text-xs leading-4 text-muted-foreground"
      >
        {copied && "Copied"}
        {error && "Copy unavailable. Select the text."}
      </span>
      <IconButton
        type="button"
        label={copyLabel}
        onClick={() => void copy("command", command)}
      >
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      </IconButton>
    </div>
  );
}
