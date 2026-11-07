import {
  CircleCheck,
  CircleDashed,
  FileText,
  GitBranch,
  Link2,
  Layers,
  Package,
  ShieldCheck,
  Trash2,
  type LucideIcon,
} from "lucide-react";

/** The badge icon for a recorded change of `kind`. */
export function historyIcon(kind: string): LucideIcon {
  if (kind === "status") return CircleDashed;
  if (kind === "evidence") return ShieldCheck;
  if (kind === "project") return Package;
  if (kind === "plan") return Layers;
  if (kind === "parent" || kind === "relationship:child") return GitBranch;
  if (kind === "dependency" || kind.startsWith("relationship:")) return Link2;
  if (kind === "trash") return Trash2;
  if (kind.startsWith("source") || kind === "publication") return FileText;
  return CircleCheck;
}
