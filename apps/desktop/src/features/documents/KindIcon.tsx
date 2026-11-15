import { FileText, Layers } from "lucide-react";
import { StatusIcon } from "@/features/tickets/StatusIcon";

/**
 * An item's glyph in graph rows and panels: a ticket's status icon, the Plan
 * or Document icon otherwise. Decorative; the row text names the item.
 */
export function KindIcon({
  kind,
  status,
}: {
  kind: string;
  status?: string | null | undefined;
}) {
  if (kind === "plan") return <Layers aria-hidden="true" />;
  if (kind === "document") return <FileText aria-hidden="true" />;
  return <StatusIcon status={status || "Todo"} size={16} decorative />;
}
