import { Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import type { View } from "@/lib/api/plans";
import { emptyCopy } from "@/lib/empty-copy";

export function PlanEmptyState({
  view,
  onAdd,
}: {
  view: View;
  onAdd: () => void;
}) {
  const { archived } = view.plan;
  const copy = emptyCopy(archived ? "plan-archived" : "plan-start");
  return (
    <EmptyState
      className="plan-empty-state"
      icon={<Layers />}
      title={copy.title}
      description={copy.sentence}
      action={
        !archived && (
          <Button variant="outline" size="sm" onClick={onAdd}>
            {copy.action}
          </Button>
        )
      }
    />
  );
}
