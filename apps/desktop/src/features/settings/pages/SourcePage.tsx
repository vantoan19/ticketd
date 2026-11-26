import { useState } from "react";
import type { SourceEntry } from "@/lib/api/sources";
import { SourceCard } from "@/features/settings/sources/SourceCard";
import { SettingsDrillIn } from "@/features/settings/layout/SettingsDrillIn";
import { CircleDot } from "lucide-react";
import "@/features/settings/sources/sources.css";

/**
 * One source's page. It mounts on first visit with the latest configuration,
 * then stays mounted but hidden while other sections are open, so its draft
 * and preview survive. A restore remounts it (the router keys it).
 */
export function SourcePage({
  entry,
  active,
  onBack,
  onProjectLinked,
}: {
  entry: SourceEntry;
  active: boolean;
  /** Returns to the Ticket sources list. */
  onBack: () => void;
  onProjectLinked?: (projectId: string, connection: string) => void;
}) {
  const [visited, setVisited] = useState(active);
  if (active && !visited) setVisited(true);
  if (!visited) return null;
  if (entry.unavailable)
    return active ? (
      <SettingsDrillIn
        parent="ticket-sources"
        onBack={onBack}
        label={entry.saved?.name ?? entry.connector.name}
        icon={CircleDot}
        lede="The extension for this connection is unavailable. You can rename or remove the connection in Ticket sources."
        children={null}
      />
    ) : null;
  return (
    <SourceCard
      entry={entry}
      hidden={!active}
      onBack={onBack}
      {...(onProjectLinked && { onProjectLinked })}
    />
  );
}
