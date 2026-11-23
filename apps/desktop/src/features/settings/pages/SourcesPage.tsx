import { useState } from "react";
import { Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { FailureAlert } from "@/components/ui/failure-alert";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";
import {
  SettingsList,
  SettingsRow,
  SettingsRowTile,
} from "@/features/settings/layout/SettingsList";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import { sectionMeta } from "@/features/settings/settings-sections";
import { SourceCard } from "@/features/settings/sources/SourceCard";
import { SourceIcon } from "@/features/settings/sources/SourceIcon";
import { useSources } from "@/features/settings/sources/use-sources";
import { describeFailure } from "@/lib/api/describe-failure";
import {
  sourcesClient,
  type SavedSource,
  type SourceEntry,
} from "@/lib/api/sources";

export function SourcesPage({ onOpen }: { onOpen: (id: string) => void }) {
  const { entries, loading } = useSources();
  const [adding, setAdding] = useState<SourceEntry | null>(null);
  const [changes, setChanges] = useState<SourceEntry[]>([]);
  const [rename, setRename] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [savingName, setSavingName] = useState(false);
  const [renameFailure, setRenameFailure] = useState<ReturnType<
    typeof describeFailure
  > | null>(null);
  const byProvider = new Map(
    entries.map((entry) => [entry.connector.provider, entry]),
  );
  const connections = new Map<string, SourceEntry>();
  for (const entry of [...entries, ...changes]) {
    if (entry.saved)
      connections.set(entry.saved.id ?? entry.connector.provider, entry);
  }

  function record(entry: SourceEntry, source: SavedSource) {
    setChanges((current) => [
      ...current.filter(({ saved }) => saved?.id !== source.id),
      { ...entry, saved: source },
    ]);
  }

  async function saveName(entry: SourceEntry, id: string, name: string) {
    setSavingName(true);
    setRenameFailure(null);
    try {
      record(entry, await sourcesClient.rename(id, name));
      setRename(null);
    } catch (reason) {
      setRenameFailure(describeFailure(reason, "rename this connection"));
    } finally {
      setSavingName(false);
    }
  }

  if (adding?.next_id) {
    return (
      <SourceCard
        entry={{ ...adding, saved: null }}
        adding={{
          id: adding.next_id,
          onCancel: () => setAdding(null),
          onAdded: (source) => {
            record(adding, source);
            setAdding(null);
          },
        }}
      />
    );
  }

  return (
    <SettingsPage
      {...sectionMeta("sources")}
      lede="Connect accounts on this desktop to discover and refresh tickets."
    >
      {loading ? (
        <p role="status">Loading sources…</p>
      ) : (
        <>
          <SettingsSection title="Connections">
            <SettingsList>
              {connections.size === 0 && (
                <SettingsRow title="No connections yet" />
              )}
              {[...connections].map(([id, entry]) => {
                const source = entry.saved;
                const name = source?.name ?? entry.connector.name;
                const editing = rename?.id === id ? rename : null;
                return (
                  <SettingsRow
                    key={id}
                    variant={editing ? "stacked" : "center"}
                    leading={
                      <SettingsRowTile>
                        <SourceIcon
                          svg={entry.connector.presentation?.icon_svg}
                        />
                      </SettingsRowTile>
                    }
                    title={name}
                    description={`${entry.connector.name} · ${source?.account ?? ""} · ${id}`}
                    trailing={
                      !editing && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => onOpen(id)}
                          >
                            Configure
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Rename ${name}`}
                            disabled={savingName}
                            onClick={() => {
                              setRenameFailure(null);
                              setRename({ id, name });
                            }}
                          >
                            <Pencil aria-hidden="true" />
                          </Button>
                        </>
                      )
                    }
                  >
                    {editing && (
                      <form
                        className="flex flex-col gap-2"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void saveName(entry, id, editing.name);
                        }}
                      >
                        <Field>
                          <FieldLabel htmlFor="connection-new-name">
                            Connection name
                          </FieldLabel>
                          <Input
                            id="connection-new-name"
                            value={editing.name}
                            maxLength={100}
                            disabled={savingName}
                            onChange={(event) =>
                              setRename({ id, name: event.target.value })
                            }
                          />
                        </Field>
                        {renameFailure && (
                          <FailureAlert
                            failure={renameFailure}
                            size="compact"
                          />
                        )}
                        <div className="flex gap-2">
                          <Button
                            type="submit"
                            size="sm"
                            disabled={savingName || !editing.name.trim()}
                          >
                            Save name
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={savingName}
                            onClick={() => setRename(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      </form>
                    )}
                  </SettingsRow>
                );
              })}
            </SettingsList>
          </SettingsSection>
          {[...byProvider.values()]
            .filter(({ next_id }) => next_id)
            .map((entry) => (
              <Button
                key={entry.connector.provider}
                variant="outline"
                size="sm"
                onClick={() => setAdding(entry)}
              >
                <Plus aria-hidden="true" /> Add {entry.connector.name}{" "}
                connection
              </Button>
            ))}
        </>
      )}
    </SettingsPage>
  );
}
