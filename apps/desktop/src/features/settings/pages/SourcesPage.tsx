import { useLayoutEffect, useRef, useState } from "react";
import { Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusLabel } from "@/components/ui/status-label";
import { DialogShell } from "@/components/ui/dialog-shell";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { FailureAlert } from "@/components/ui/failure-alert";
import type { ProjectSourceSetup } from "@/features/projects/ConnectProjectSource";
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
  const [adding, setAdding] = useState<SourceEntry | null>(null);
  const [additions, setAdditions] = useState<SourceEntry[]>([]);
  const [names, setNames] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const [removed, setRemoved] = useState<string[]>([]);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [removalPending, setRemovalPending] = useState(false);
  const [removalFailure, setRemovalFailure] = useState<ReturnType<
    typeof describeFailure
  > | null>(null);
  const nextAction = useRef<HTMLButtonElement>(null);
  const removalTrigger = useRef<HTMLButtonElement>(null);
  const [rename, setRename] = useState<{ id: string; name: string } | null>(
    null,
  );
  const renameInput = useRef<HTMLInputElement>(null);
  const renameButtons = useRef(new Map<string, HTMLButtonElement>());
  const returnRenameFocus = useRef<string | null>(null);
  const renamingId = rename?.id;
  useLayoutEffect(() => {
    if (renamingId) {
      renameInput.current?.focus();
    } else if (returnRenameFocus.current) {
      renameButtons.current.get(returnRenameFocus.current)?.focus();
      returnRenameFocus.current = null;
    }
  }, [renamingId]);
  const [savingName, setSavingName] = useState(false);
  const [renameFailure, setRenameFailure] = useState<ReturnType<
    typeof describeFailure
  > | null>(null);
  const byProvider = new Map(
    entries.map((entry) => [entry.connector.provider, entry]),
  );
  const projectEntry = projectSetup
    ? entries.find(
        ({ connector, next_id }) =>
          connector.provider === projectSetup.setup.provider && next_id,
      )
    : undefined;
  const connections = new Map<string, SourceEntry>();
  for (const entry of entries) {
    if (entry.saved)
      connections.set(entry.saved.id ?? entry.connector.provider, entry);
  }
  const pendingAdditions = additions.filter(
    ({ saved }) => saved?.id && !connections.has(saved.id),
  );
  if (pendingAdditions.length !== additions.length)
    setAdditions(pendingAdditions);
  for (const entry of pendingAdditions) {
    if (entry.saved?.id) connections.set(entry.saved.id, entry);
  }
  for (const id of removed) connections.delete(id);
  const pendingNames = new Map(
    [...names].filter(([id, name]) => {
      const source = connections.get(id)?.saved;
      return source && source.name !== name;
    }),
  );
  if (pendingNames.size !== names.size) setNames(pendingNames);

  function recordAdded(entry: SourceEntry, source: SavedSource) {
    const updated = { ...entry, saved: source };
    setRemoved((current) => current.filter((id) => id !== source.id));
    setAdditions((current) => [
      ...current.filter(({ saved }) => saved?.id !== source.id),
      updated,
    ]);
    return updated;
  }

  function closeRename(id: string) {
    returnRenameFocus.current = id;
    setRename(null);
  }

  async function saveName(id: string, name: string) {
    setSavingName(true);
    setRenameFailure(null);
    try {
      const savedName = (await sourcesClient.rename(id, name)).name;
      if (savedName) setNames((current) => new Map(current).set(id, savedName));
      closeRename(id);
      void onChanged?.();
    } catch (reason) {
      setRenameFailure(describeFailure(reason, "rename this connection"));
    } finally {
      setSavingName(false);
    }
  }

  async function remove(id: string) {
    setRemovalPending(true);
    setRemovalFailure(null);
    try {
      await sourcesClient.remove(id);
      setRemoved((current) => [...current, id]);
      setAdditions((current) =>
        current.filter(({ saved }) => saved?.id !== id),
      );
      setRemoving(null);
      await onChanged?.();
    } catch (reason) {
      setRemovalFailure(describeFailure(reason, "remove this connection"));
    } finally {
      setRemovalPending(false);
    }
  }

  if (projectSetup && projectEntry?.next_id) {
    return (
      <SourceCard
        key={projectEntry.next_id}
        entry={{ ...projectEntry, saved: null }}
        initialRepository={projectSetup.setup.repository}
        adding={{
          id: projectEntry.next_id,
          onCancel: projectSetup.onCancel,
          onAdded: (source) => {
            void onChanged?.(recordAdded(projectEntry, source));
            if (source.id) projectSetup.onSaved(source.id);
          },
        }}
      />
    );
  }
  if (adding?.next_id) {
    return (
      <SourceCard
        entry={{ ...adding, saved: null }}
        adding={{
          id: adding.next_id,
          onCancel: () => setAdding(null),
          onAdded: (source) => {
            const added = recordAdded(adding, source);
            setAdding(null);
            void onChanged?.(added);
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
          <SettingsSection title="Connections">
            <SettingsList>
              {connections.size === 0 && (
                <SettingsRow title="No connections yet" />
              )}
              {[...connections].map(([id, entry]) => {
                const source = entry.saved;
                const name =
                  pendingNames.get(id) ?? source?.name ?? entry.connector.name;
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
                          {entry.development && (
                            <Badge variant="experimental">Development</Badge>
                          )}
                          {entry.unavailable ? (
                            <StatusLabel tone="attention">
                              Extension unavailable
                            </StatusLabel>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => onOpen(id)}
                            >
                              Configure
                            </Button>
                          )}
                          <Button
                            ref={(button) => {
                              if (button) renameButtons.current.set(id, button);
                              else renameButtons.current.delete(id);
                            }}
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
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Remove ${name}`}
                            onClick={(event) => {
                              removalTrigger.current = event.currentTarget;
                              setRemovalFailure(null);
                              setRemoving({ id, name });
                            }}
                          >
                            Remove…
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
                          void saveName(id, editing.name);
                        }}
                      >
                        <Field>
                          <FieldLabel htmlFor="connection-new-name">
                            Connection name
                          </FieldLabel>
                          <Input
                            ref={renameInput}
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
                            onClick={() => closeRename(id)}
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
            .map((entry, index) => (
              <Button
                ref={index === 0 ? nextAction : undefined}
                key={entry.connector.provider}
                variant="outline"
                size="sm"
                disabled={Boolean(
                  entry.next_id &&
                  (connections.has(entry.next_id) ||
                    removed.includes(entry.next_id)),
                )}
                onClick={() => setAdding(entry)}
              >
                <Plus aria-hidden="true" /> Add {entry.connector.name}{" "}
                connection
                {entry.development && <span>(development)</span>}
              </Button>
            ))}
          {removing && (
            <DialogShell
              open
              onOpenChange={(open) => {
                if (!open && !removalPending) setRemoving(null);
              }}
              size="sm"
              title={`Remove ${removing.name}?`}
              description="Its tickets keep their last synced content, local work, and links to their issues. You can take ownership of a ticket to edit it here. Sync resumes if a connection discovers the issue again."
              primaryLabel={removalPending ? "Removing…" : "Remove connection"}
              primaryVariant="destructive"
              blockedReason={null}
              busy={removalPending}
              resolveReturnFocus={() =>
                removalTrigger.current?.isConnected
                  ? removalTrigger.current
                  : nextAction.current
              }
              error={
                removalFailure && (
                  <FailureAlert size="compact" failure={removalFailure} />
                )
              }
              onSubmit={() => void remove(removing.id)}
            />
          )}
        </>
      )}
    </SettingsPage>
  );
}
