import { useState } from "react";
import type { SourceEntry } from "@/lib/api/sources";
import { SourceCard } from "@/features/settings/sources/SourceCard";
import "@/features/settings/sources/sources.css";

/**
 * One source's page. It mounts on first visit with the latest configuration,
 * then stays mounted but hidden while other sections are open, so its draft
 * and preview survive. A restore remounts it (the router keys it).
 */
export function SourcePage({
  entry,
  active,
  initialRepository,
  onSaved,
  onProjectLinked,
}: {
  entry: SourceEntry;
  active: boolean;
  initialRepository?: string;
  onSaved?: () => void;
  onProjectLinked?: (projectId: string) => void;
}) {
  const [visited, setVisited] = useState(active);
  if (active && !visited) setVisited(true);
  if (!visited) return null;
  return (
    <SourceCard
      entry={entry}
      hidden={!active}
      {...(initialRepository && { initialRepository })}
      {...(onSaved && { onSaved })}
      {...(onProjectLinked && { onProjectLinked })}
    />
  );
}
