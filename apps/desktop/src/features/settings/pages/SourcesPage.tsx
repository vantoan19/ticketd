import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusLabel } from "@/components/ui/status-label";
import { IconTile } from "@/components/ui/icon-tile";
import type { StatusDotTone } from "@/components/ui/status-dot";
import type { ProjectSourceSetup } from "@/features/projects/ConnectProjectSource";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";
import { sectionMeta } from "@/features/settings/settings-sections";
import { SourceCard } from "@/features/settings/sources/SourceCard";
import { SourceIcon } from "@/features/settings/sources/SourceIcon";
import {
  sourceRows,
  type SourceRow,
  type SourceRowStatus,
} from "@/features/settings/sources/source-rows";
import { useSources } from "@/features/settings/sources/use-sources";
import { useSourceActivity } from "@/features/tickets/source-activity";
import { useNow } from "@/lib/use-now";
import type { SavedSource, SourceEntry } from "@/lib/api/sources";
import "@/features/settings/pages/sources-table.css";

const TONES: Record<SourceRowStatus, StatusDotTone> = {
  Connected: "positive",
  "Not connected": "neutral",
  "Needs sign-in": "attention",
  Unavailable: "attention",
};

/**
 * Ticket sources: one table of every source, built in or added, with how it is
 * doing. A row opens that source's page in place; connecting, renaming and
 * removing happen there.
 */
export function SourcesPage({
  onOpen,
  onChanged,
  projectSetup,
}: {
  onOpen: (id: string) => void;
  onChanged?: ((added?: SourceEntry) => Promise<void>) | undefined;
  projectSetup?: {
    setup: ProjectSourceSetup;
    onSaved: (connection: string) => void;
    onCancel: () => void;
  };
}) {
  const { entries, loading } = useSources();
  const { sources: health } = useSourceActivity();
  const now = useNow();
  const projectEntry = projectSetup
    ? entries.find(
        ({ connector, next_id }) =>
          connector.provider === projectSetup.setup.provider && next_id,
      )
    : undefined;

  if (projectSetup && projectEntry?.next_id) {
    return (
      <SourceCard
        key={projectEntry.next_id}
        entry={{ ...projectEntry, saved: null }}
        initialRepository={projectSetup.setup.repository}
        adding={{
          id: projectEntry.next_id,
          onCancel: projectSetup.onCancel,
          onAdded: (source: SavedSource) => {
            void onChanged?.({ ...projectEntry, saved: source });
            if (source.id) projectSetup.onSaved(source.id);
          },
        }}
      />
    );
  }

  const rows = sourceRows(entries, health, now);
  return (
    <SettingsPage {...sectionMeta("ticket-sources")}>
      {loading ? (
        <p role="status">Loading sources…</p>
      ) : (
        <>
          {projectSetup && (
            <p>
              Source setup is unavailable.{" "}
              <Button
                variant="link"
                size="inline"
                onClick={projectSetup.onCancel}
              >
                Return to project
              </Button>
            </p>
          )}
          <section className="settings-section">
            <table className="sources-table">
              <caption className="sr-only">Ticket sources</caption>
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col">Status</th>
                  <th scope="col">Signs in with</th>
                  <th scope="col">Brings in</th>
                  <th scope="col">
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <SourceTableRow key={row.id} row={row} onOpen={onOpen} />
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={5}>
                    Connected on this computer only. Connect them again on your
                    other computers.
                  </td>
                </tr>
              </tfoot>
            </table>
          </section>
        </>
      )}
    </SettingsPage>
  );
}

function SourceTableRow({
  row,
  onOpen,
}: {
  row: SourceRow;
  onOpen: (id: string) => void;
}) {
  return (
    <tr onClick={() => onOpen(row.id)}>
      <th scope="row">
        <button
          type="button"
          className="sources-table-open"
          onClick={(event) => {
            event.stopPropagation();
            onOpen(row.id);
          }}
        >
          <IconTile>
            <SourceIcon svg={row.entry.connector.presentation?.icon_svg} />
          </IconTile>
          <span className="sources-table-name">
            <span className="sources-table-name-line">
              {row.name}
              {row.development && (
                <Badge variant="experimental">Development</Badge>
              )}
            </span>
            <span className="sources-table-sub">{row.origin}</span>
          </span>
        </button>
      </th>
      <td>
        <StatusLabel tone={TONES[row.status]}>{row.status}</StatusLabel>
      </td>
      <td>{row.signsInWith}</td>
      <td>
        {row.bringsIn ? (
          <span className="sources-table-brings">
            {row.bringsIn}
            {row.refreshed && (
              <span className="sources-table-sub">{row.refreshed}</span>
            )}
          </span>
        ) : (
          <span className="sources-table-none">Nothing yet</span>
        )}
      </td>
      <td className="sources-table-end">
        <span className="sources-table-chevron">
          <ChevronRight size={16} aria-hidden="true" />
        </span>
      </td>
    </tr>
  );
}
