import { Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useChatFeature } from "@/features/chats/use-chats";
import type { View } from "@/lib/api/plans";
import { emptyCopy } from "@/lib/empty-copy";

export function PlanEmptyState({
  view,
  onAdd,
}: {
  view: View;
  onAdd: () => void;
}) {
  const { enabled, requestChat } = useChatFeature();
  const { archived, name, spec_document_id } = view.plan;
  const copy = emptyCopy(archived ? "plan-archived" : "plan-start");
  function planWithAgent() {
    const spec = view.documents.find(
      (document) => document.id === spec_document_id && !document.trashed,
    );
    requestChat({
      kind: "new",
      start: {
        planName: name,
        spec: spec
          ? { kind: "document", id: spec.id, title: spec.heading }
          : null,
        folder: null,
      },
    });
  }
  return (
    <EmptyState
      icon={<Layers />}
      title={copy.title}
      description={copy.sentence}
      action={
        !archived && (
          <>
            {enabled && (
              <Button variant="outline" size="sm" onClick={planWithAgent}>
                Plan it with an agent
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={onAdd}>
              {copy.action}
            </Button>
          </>
        )
      }
    />
  );
}
