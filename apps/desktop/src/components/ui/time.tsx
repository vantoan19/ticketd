import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { compactAgo, formatDateTime, relativeDateTime } from "@/lib/format";
import { useNow } from "@/lib/use-now";

/**
 * A stored time as people read it: `sentence` ("5 h ago", the default) or
 * `compact` for trailing columns ("5h"), both a short date after a week. The
 * exact local time is in a tooltip on the focusable `<time>`. Not for a time
 * inside a row that is itself a button (nested focus): use the format helpers
 * there.
 */
export function Time({
  value,
  format = "sentence",
  className,
}: {
  value: string;
  format?: "sentence" | "compact";
  className?: string;
}) {
  const now = useNow();
  const text =
    format === "compact"
      ? (compactAgo(value, now) ?? value)
      : relativeDateTime(value, now);
  const exact = formatDateTime(value);
  if (exact === value) return <span className={className}>{value}</span>;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <time dateTime={value} tabIndex={0} {...(className && { className })}>
            {text}
          </time>
        </TooltipTrigger>
        <TooltipContent>{exact}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
