import type { ReactNode } from "react";
import { Expand } from "@/components/ui/motion";
import { useHeldExpand } from "@/components/ui/use-held-expand";

/**
 * A sidebar group that is a list when the sidebar is open and one icon (`rail`)
 * when it is the rail. Each side is an Expand: one closes while the other
 * opens, on the same spring, so the groups below glide with the height instead
 * of jumping. The side that leaves stays mounted, inert, until it is closed.
 */
export function FoldingGroup({
  collapsed,
  rail,
  children,
}: {
  collapsed: boolean;
  rail: ReactNode;
  children: ReactNode;
}) {
  const icon = useHeldExpand(collapsed);
  const list = useHeldExpand(!collapsed);
  return (
    <>
      {icon.mounted && <Expand open={icon.expanded}>{rail}</Expand>}
      {list.mounted && <Expand open={list.expanded}>{children}</Expand>}
    </>
  );
}
