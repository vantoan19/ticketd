import {
  Circle,
  CircleEqual,
  FileText,
  GitBranch,
  Link2,
  Layers,
  Package,
  ShieldCheck,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { statusIcons } from "./status-icons";

/** The badge icon for a recorded change of `kind`; a status change shows its new status. */
export function historyIcon(kind: string, to = ""): LucideIcon {
  if (kind === "status") return statusIcons[to] ?? Circle;
  if (kind === "external_duplicate") return CircleEqual;
  if (kind === "evidence") return ShieldCheck;
  if (kind === "project") return Package;
  if (kind === "plan") return Layers;
  if (kind === "parent" || kind === "relationship:child") return GitBranch;
  if (
    kind === "dependency" ||
    kind === "sync_dependency_removed" ||
    kind.startsWith("relationship:")
  )
    return Link2;
  if (kind === "trash") return Trash2;
  if (
    kind.startsWith("source") ||
    kind.startsWith("publication") ||
    kind === "ownership"
  )
    return FileText;
  return Circle;
}
