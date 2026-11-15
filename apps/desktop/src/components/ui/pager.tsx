import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import "./patterns.css";

/**
 * The one paging pattern: a centred outline "Show 50 more" under the content.
 * While loading it keeps its width, is disabled and spins; totals belong in
 * the header, never here. `more` is how many the next page holds (or what is
 * left, when fewer); `noun` names what is shown for the accessible name.
 */
export function Pager({
  more,
  noun,
  loading = false,
  onMore,
  className,
}: {
  more: number;
  noun?: string;
  loading?: boolean;
  onMore: () => void;
  className?: string;
}) {
  if (more <= 0) return null;
  return (
    <div data-slot="pager" className={className ?? "ui-pager"}>
      <Button
        variant="outline"
        size="sm"
        disabled={loading}
        aria-busy={loading || undefined}
        aria-label={noun ? `Show ${more} more ${noun}` : undefined}
        className="relative"
        onClick={onMore}
      >
        {/* The label keeps the button's width while the spinner stands in. */}
        <span className={loading ? "invisible" : undefined}>
          Show {more} more
        </span>
        {loading && (
          <Loader2 className="absolute animate-spin" aria-hidden="true" />
        )}
      </Button>
    </div>
  );
}
