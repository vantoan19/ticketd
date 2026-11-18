import type { ReactNode } from "react";
import { Expand } from "@/components/ui/motion";
import { useHeldExpand } from "@/components/ui/use-held-expand";

/**
 * A sidebar group that may arrive late (Projects and Plans, once the workspace
 * has said it has any) or leave. It opens or closes its height and fades on the
 * smooth spring, so the groups below glide with it instead of being pushed down
 * in one frame. A group already there on first render simply is.
 */
export function ArrivingGroup({
  present,
  children,
}: {
  present: boolean;
  children: ReactNode;
}) {
  const group = useHeldExpand(present);
  if (!group.mounted) return null;
  return <Expand open={group.expanded}>{children}</Expand>;
}
