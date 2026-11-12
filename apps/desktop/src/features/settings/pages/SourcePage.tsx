import { useState } from "react";
import { CircleDot } from "lucide-react";
import type { SourceEntry } from "@/lib/api/sources";
import { SourceCard } from "@/features/settings/sources/SourceCard";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";
import "@/features/settings/sources/sources.css";

/**
 * One source's page. It mounts on first visit with the latest configuration,
 * then stays mounted but hidden while other sections are open, so its draft
 * and preview survive. A restore remounts it (the router keys it).
 */
export function SourcePage({
  entry,
  active,
}: {
  entry: SourceEntry;
  active: boolean;
}) {
  const [visited, setVisited] = useState(active);
  if (active && !visited) setVisited(true);
  if (!visited) return null;
  return (
    <SettingsPage
      group="Connections"
      label={entry.connector.name}
      icon={CircleDot}
      lede="Bring matching GitHub issues into this workspace. Their title, description, state and comments sync inward; GitHub stays the place to edit them."
      hidden={!active}
    >
      <SourceCard entry={entry} />
    </SettingsPage>
  );
}
