import { useState } from "react";
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { ConflictSummary, RecordKind } from "@/lib/sync-review-api";
import { ConflictReview } from "./ConflictReview";
import { fieldList } from "./labels";
import { useConflicts } from "./use-conflicts";

/**
 * The notice at the top of a record whose fields were changed on two desktops.
 * It renders nothing for a record without a conflict.
 */
export function NeedsReviewNotice({
  kind,
  id,
  className,
}: {
  kind: RecordKind;
  id: string;
  className?: string;
}) {
  const { conflicts, reload } = useConflicts();
  // Kept while its comparison is open: a conflict that sync withdraws meanwhile
  // leaves the list, and the comparison is where the person is told.
  const [reviewing, setReviewing] = useState<ConflictSummary | null>(null);
  const conflict = conflicts.find(
    (item) => item.kind === kind && item.id === id,
  );
  return (
    <>
      {conflict && (
        <Alert
          tone="attention"
          role="region"
          aria-label="Needs review"
          className={className}
        >
          <AlertTitle>Needs review</AlertTitle>
          <AlertDescription>
            {fieldList(kind, conflict.fields)}{" "}
            {conflict.fields.length > 1 ? "were" : "was"} changed on two
            desktops. This desktop’s version is shown until you choose.
          </AlertDescription>
          <AlertActions>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setReviewing(conflict)}
            >
              Review changes
            </Button>
          </AlertActions>
        </Alert>
      )}
      {reviewing && (
        <ConflictReview
          conflict={reviewing}
          onClose={() => setReviewing(null)}
          onResolved={reload}
        />
      )}
    </>
  );
}
