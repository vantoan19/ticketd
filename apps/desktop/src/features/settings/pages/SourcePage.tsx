import { useState } from "react";
import { useSourceActivity } from "@/features/tickets/source-activity";
import { SourceManage } from "@/features/settings/sources/SourceManage";
import type { SourceEntry } from "@/lib/api/sources";
import {
  CustomSourceEmpty,
  CustomTag,
  ProgramSection,
} from "@/features/settings/sources/CustomSource";
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
  onOpen,
  onProjectLinked,
}: {
  entry: SourceEntry;
  active: boolean;
  /** Returns to the Ticket sources list. */
  onBack: () => void;
  /** Called after the connection was removed or added, so the catalog can be read again. */
  onChanged?: (added?: SourceEntry) => Promise<void>;
  /** Opens another source's page (a connection just added). */
  onOpen?: (id: string) => void;
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
  // A source a person added (not a development link, which keeps its own page).
  const custom = entry.extension !== undefined && !entry.extension.development;
  const program = (
    <ProgramSection
      entry={entry}
      onRemoved={() => {
        void (async () => {
          if (onChanged) await onChanged();
          else schedule.readCatalog?.();
          onBack();
        })();
      }}
    />
  );
  if (entry.unavailable)
    return active ? (
      <SettingsDrillIn
        parent="ticket-sources"
        onBack={onBack}
        label={entry.saved?.name ?? entry.connector.name}
        icon={CircleDot}
        titleAccessory={custom && <CustomTag />}
        lede="The program for this source is missing or has changed, so ticketd can't read it. Its tickets keep their last synced content."
      >
        {manage}
        {custom && program}
      </SettingsDrillIn>
    ) : null;
  if (custom && !entry.saved)
    return (
      <CustomSourceEmpty
        entry={entry}
        hidden={!active}
        onBack={onBack}
        onRemoved={() => {
          void (async () => {
            if (onChanged) await onChanged();
            else schedule.readCatalog?.();
            onBack();
          })();
        }}
        onConnected={(source) => {
          void (async () => {
            await onChanged?.({ ...entry, saved: source });
            if (source.id) onOpen?.(source.id);
          })();
        }}
      />
    );
  return (
    <SourceCard
      entry={entry}
      hidden={!active}
      onBack={onBack}
      manage={
        custom ? (
          <>
            {manage}
            {program}
          </>
        ) : (
          manage
        )
      }
      {...(custom && { tag: <CustomTag /> })}
      {...(onProjectLinked && { onProjectLinked })}
    />
  );
}
