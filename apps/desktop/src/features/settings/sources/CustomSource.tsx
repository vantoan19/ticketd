import { useState } from "react";
import { CircleDot } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { SettingsDrillIn } from "@/features/settings/layout/SettingsDrillIn";
import {
  SettingsList,
  SettingsListFooter,
} from "@/features/settings/layout/SettingsList";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import {
  ProgramFacts,
  useAddCustomSource,
} from "@/features/settings/sources/custom-source";
import { SourceCard } from "@/features/settings/sources/SourceCard";
import { SourceIcon } from "@/features/settings/sources/SourceIcon";
import {
  plural,
  signsInWith,
} from "@/features/settings/sources/source-rows";
import { useSourceActivity } from "@/features/tickets/source-activity";
import { describeFailure } from "@/lib/api/describe-failure";
import {
  sourcesClient,
  type SavedSource,
  type SourceEntry,
} from "@/lib/api/sources";

/** The tag beside the name of a source a person added. */
export function CustomTag() {
  return <Badge variant="tag">Custom</Badge>;
}

/**
 * What the program behind a custom source is, and what a person can do with it:
 * add it again when its files changed, or remove it. It lives on the source's
 * page, under its connections.
 */
export function ProgramSection({
  entry,
  onRemoved,
}: {
  entry: SourceEntry;
  /** Called once the program is gone and the catalog has been told. */
  onRemoved: () => void;
}) {
  const { readCatalog } = useSourceActivity();
  const { extension } = entry;
  const id = extension?.id ?? entry.connector.provider;
  const name = entry.connector.name;
  // Its files changed, or the program is gone altogether.
  const stopped = extension ? extension.stopped : entry.unavailable === true;
  const again = useAddCustomSource({
    expectId: id,
    onAdded: () => void readCatalog?.(),
  });
  const [removing, setRemoving] = useState(false);
  const [removed, setRemoved] = useState<"busy" | string | null>(null);
  async function remove() {
    setRemoved("busy");
    try {
      await sourcesClient.removeExtension(id);
      readCatalog?.();
      setRemoving(false);
      setRemoved(null);
      onRemoved();
    } catch (reason) {
      setRemoved(describeFailure(reason, "remove this source").sentence);
    }
  }
  return (
    <SettingsSection title="Program">
      <SettingsList>
        {extension ? (
          <ProgramFacts extension={extension} fromLabel="Added from" />
        ) : null}
        <SettingsListFooter
          actions={
            <>
              {stopped && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={again.busy}
                  onClick={again.choose}
                >
                  Add again…
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setRemoved(null);
                  setRemoving(true);
                }}
              >
                Remove source…
              </Button>
            </>
          }
        >
          {!stopped
            ? "ticketd stops it if its files change, until you add it again."
            : extension
              ? "Its files changed, so ticketd stopped it. It stays stopped until you add it again."
              : "ticketd can’t find this program. It stays stopped until you add it again."}
          {again.refusal && (
            <span role="alert" className="program-refusal">
              {again.refusal}
            </span>
          )}
        </SettingsListFooter>
      </SettingsList>
      {again.dialog}
      {removing && (
        <DialogShell
          open
          size="sm"
          onOpenChange={(open) => {
            if (!open && removed !== "busy") setRemoving(false);
          }}
          title={`Remove ${name}?`}
          description="ticketd stops running it. Its connections stay saved and can’t sync until you add it again."
          primaryLabel={removed === "busy" ? "Removing…" : "Remove source"}
          primaryVariant="destructive"
          blockedReason={removed === "busy" ? "Removing…" : null}
          busy={removed === "busy"}
          error={removed !== null && removed !== "busy" ? removed : null}
          onSubmit={() => void remove()}
        >
          <p className="text-sm text-muted-foreground">
            The copy ticketd keeps of {name} is deleted. Tickets it brought
            in stay.
          </p>
        </DialogShell>
      )}
    </SettingsSection>
  );
}

/**
 * A custom source with no connection yet: it says so, offers to add one (the
 * program's own form), and shows the program.
 */
export function CustomSourceEmpty({
  entry,
  hidden,
  onBack,
  onRemoved,
  onConnected,
}: {
  entry: SourceEntry;
  hidden: boolean;
  onBack: () => void;
  onRemoved: () => void;
  /** A connection was saved: show its page. */
  onConnected: (source: SavedSource) => void;
}) {
  const [adding, setAdding] = useState(false);
  const { connector } = entry;
  if (adding && entry.next_id)
    return (
      <SourceCard
        entry={entry}
        hidden={hidden}
        adding={{
          id: entry.next_id,
          onCancel: () => setAdding(false),
          onAdded: (source) => {
            setAdding(false);
            onConnected(source);
          },
        }}
      />
    );
  const target = connector.presentation?.target;
  const signs = signsInWith(entry);
  const sentence = [
    signs === "No sign-in"
      ? null
      : `Sign in with ${signs.charAt(0).toLowerCase()}${signs.slice(1)}`,
    target
      ? `choose the ${plural(target.label.toLowerCase(), 2)} that come in`
      : "choose what comes in",
  ]
    .filter(Boolean)
    .join(", then ");
  return (
    <SettingsDrillIn
      parent="ticket-sources"
      onBack={onBack}
      hidden={hidden}
      label={connector.name}
      icon={CircleDot}
      iconContent={<SourceIcon svg={connector.presentation?.icon_svg} />}
      titleAccessory={<CustomTag />}
      lede={`Your ${connector.name} issues arrive as tickets. Edit them in ${connector.name}.`}
    >
      <SettingsSection title="Connections">
        <SettingsList>
          <EmptyState
            icon={<CircleDot />}
            title="Not connected yet"
            description={`${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`}
            action={
              <Button size="sm" onClick={() => setAdding(true)}>
                Add a connection
              </Button>
            }
          />
        </SettingsList>
      </SettingsSection>
      <ProgramSection entry={entry} onRemoved={onRemoved} />
    </SettingsDrillIn>
  );
}
