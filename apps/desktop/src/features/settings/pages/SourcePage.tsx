import { useState } from "react";
import { useSourceActivity } from "@/features/tickets/source-activity";
import { SourceManage } from "@/features/settings/sources/SourceManage";
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
  onChanged,
  onProjectLinked,
}: {
  entry: SourceEntry;
  active: boolean;
  /** Returns to the Ticket sources list. */
  onBack: () => void;
  /** Called after the connection was removed, so the catalog can be read again. */
  onChanged?: () => Promise<void>;
  onProjectLinked?: (projectId: string, connection: string) => void;
}) {
  const schedule = useSourceActivity();
  const [visited, setVisited] = useState(active);
  if (active && !visited) setVisited(true);
  if (!visited) return null;
  const connection = entry.saved?.id;
  const manage = connection ? (
    <SourceManage
      id={connection}
      name={entry.saved?.name ?? entry.connector.name}
      onRemoved={() => {
        void (async () => {
          if (onChanged) await onChanged();
          else schedule.readCatalog?.();
          onBack();
        })();
      }}
    />
  ) : null;
  if (entry.unavailable)
    return active ? (
      <SettingsDrillIn
        parent="ticket-sources"
        onBack={onBack}
        label={entry.saved?.name ?? entry.connector.name}
        icon={CircleDot}
        lede="The program for this source is missing or has changed, so ticketd can't read it. Its tickets keep their last synced content."
      >
        {manage}
      </SettingsDrillIn>
    ) : null;
  return (
    <SourceCard
      entry={entry}
      hidden={!active}
      onBack={onBack}
      manage={manage}
      {...(onProjectLinked && { onProjectLinked })}
    />
  );
}
