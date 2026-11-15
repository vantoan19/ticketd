import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import "./patterns.css";

/**
 * The one paging pattern: a centred outline "Show 50 more" under the content,
 * never Previous and Next. While loading it keeps its width, is disabled and
 * spins; totals belong in the header, never here. `more` is how many the next
 * page holds (or what is left, when fewer); leave it out when the source
 * cannot say ("Show more"). `noun` completes the accessible name ("Show 50
 * more Todo").
 */
export function Pager({
  more,
  noun,
  loading = false,
  onMore,
}: {
  more?: number;
  noun?: string;
  loading?: boolean;
  onMore: () => void;
}) {
  if (more !== undefined && more <= 0) return null;
  const label = more === undefined ? "Show more" : `Show ${more} more`;
  return (
    <div data-slot="pager" className="ui-pager">
      <Button
        variant="outline"
        size="sm"
        disabled={loading}
        aria-busy={loading || undefined}
        aria-label={noun ? `${label} ${noun}` : undefined}
        className="relative"
        onClick={onMore}
      >
        {/* The label keeps the button's width while the spinner stands in. */}
        <span className={loading ? "invisible" : undefined}>{label}</span>
        {loading && (
          <Loader2 className="absolute animate-spin" aria-hidden="true" />
        )}
      </Button>
    </div>
  );
}
