import { useState } from "react";
import type { SourceEntry } from "@/lib/api/sources";
import { SourceCard } from "@/features/settings/sources/SourceCard";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";
import { sectionMeta } from "@/features/settings/settings-sections";
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
  if (entry.unavailable)
    return active ? (
      <SettingsPage
        {...sectionMeta("sources")}
        title={entry.saved?.name ?? entry.connector.name}
        lede="The extension for this connection is unavailable. You can rename or remove the connection in Sources."
      />
    ) : null;
  return <SourceCard entry={entry} hidden={!active} />;
}
