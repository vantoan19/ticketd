import { Crosshair } from "lucide-react";
import { GraphRow } from "@/components/ui/graph-kit";
import { IconButton } from "@/components/ui/icon-button";
import type { ContextGraph } from "@/lib/api/client";
import { cardParts, nodeName, statusOf } from "./graph-text";
import { KindIcon } from "./KindIcon";

type GraphNode = ContextGraph["nodes"][number];

/**
 * One item in a graph list or panel (graph kit row): its glyph, reference,
 * kind and state, and title; named with a Trash suffix when trashed.
 * `onFocus` adds the hover "Focus on this item" button.
 */
export function GraphItemRow({
  node,
  current,
  caption,
  onSelect,
  onFocus,
}: {
  node: GraphNode;
  current: boolean;
  /** Replaces the kind and state caption (a project name added). */
  caption?: string;
  onSelect: () => void;
  onFocus?: (() => void) | undefined;
}) {
  const parts = cardParts(node);
  return (
    <GraphRow
      icon={<KindIcon kind={node.kind} status={statusOf(node)} />}
      reference={parts.ref || null}
      caption={caption ?? parts.caption}
      title={parts.title}
      label={nodeName(node)}
      current={current}
      onClick={onSelect}
      trailing={
        onFocus && (
          <IconButton
            label="Focus on this item"
            size="icon-xs"
            tooltipSide="top"
            onClick={onFocus}
          >
            <Crosshair />
          </IconButton>
        )
      }
    />
  );
}
