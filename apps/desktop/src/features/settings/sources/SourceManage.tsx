import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import { Field, FieldLabel } from "@/components/ui/field";
import { FailureAlert } from "@/components/ui/failure-alert";
import { Input } from "@/components/ui/input";
import {
  SettingsList,
  SettingsRow,
} from "@/features/settings/layout/SettingsList";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import { useSourceActivity } from "@/features/tickets/source-activity";
import { describeFailure } from "@/lib/api/describe-failure";
import { sourcesClient } from "@/lib/api/sources";

/**
 * What a person does with a saved connection itself, on its own page: give it
 * another name (its ID stays) or remove it. Removing returns to the table.
 */
export function SourceManage({
  id,
  name,
  onRemoved,
}: {
  id: string;
  /** The name the catalog holds. */
  name: string;
  /** Called once the connection is gone, after the catalog has been told. */
  onRemoved: () => void;
}) {
  const { readCatalog } = useSourceActivity();
  // The name just saved shows at once; the catalog's own name replaces it.
  const [renamed, setRenamed] = useState<{ from: string; name: string } | null>(
    null,
  );
  const shown = renamed && renamed.from === name ? renamed.name : name;
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [renameFailure, setRenameFailure] = useState<ReturnType<
    typeof describeFailure
  > | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removalPending, setRemovalPending] = useState(false);
  const [removalFailure, setRemovalFailure] = useState<ReturnType<
    typeof describeFailure
  > | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const renameButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const removeButton = useRef<HTMLButtonElement>(null);
  const editing = draft !== null;
  useLayoutEffect(() => {
    if (editing) input.current?.focus();
    else if (returnFocus.current) {
      renameButton.current?.focus();
      returnFocus.current = false;
    }
  }, [editing]);

  function close() {
    returnFocus.current = true;
    setDraft(null);
  }

  async function saveName(next: string) {
    setSaving(true);
    setRenameFailure(null);
    try {
      const saved = (await sourcesClient.rename(id, next)).name;
      if (saved) setRenamed({ from: name, name: saved });
      readCatalog?.();
      close();
    } catch (reason) {
      setRenameFailure(describeFailure(reason, "rename this connection"));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setRemovalPending(true);
    setRemovalFailure(null);
    try {
      await sourcesClient.remove(id);
      setRemoving(false);
      onRemoved();
    } catch (reason) {
      setRemovalFailure(describeFailure(reason, "remove this connection"));
    } finally {
      setRemovalPending(false);
    }
  }

  return (
    <SettingsSection title="Manage">
      <SettingsList>
        <SettingsRow
          variant={editing ? "stacked" : "center"}
          title="Name"
          description={editing ? undefined : shown}
          trailing={
            !editing && (
              <Button
                ref={renameButton}
                size="sm"
                variant="ghost"
                aria-label={`Rename ${shown}`}
                onClick={() => {
                  setRenameFailure(null);
                  setDraft(shown);
                }}
              >
                Rename
              </Button>
            )
          }
        >
          {editing && (
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void saveName(draft);
              }}
            >
              <Field>
                <FieldLabel htmlFor="connection-new-name">
                  Connection name
                </FieldLabel>
                <Input
                  ref={input}
                  id="connection-new-name"
                  value={draft}
                  maxLength={100}
                  disabled={saving}
                  onChange={(event) => setDraft(event.target.value)}
                />
              </Field>
              {renameFailure && (
                <FailureAlert failure={renameFailure} size="compact" />
              )}
              <div className="flex gap-2">
                <Button
                  type="submit"
                  size="sm"
                  disabled={saving || !draft.trim()}
                >
                  Save name
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={saving}
                  onClick={close}
                >
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </SettingsRow>
        <SettingsRow
          title="Remove connection"
          description="Its tickets keep their last synced content and your work."
          trailing={
            <Button
              ref={removeButton}
              size="sm"
              variant="ghost"
              aria-label={`Remove ${shown}`}
              onClick={() => {
                setRemovalFailure(null);
                setRemoving(true);
              }}
            >
              Remove…
            </Button>
          }
        />
      </SettingsList>
      {removing && (
        <DialogShell
          open
          onOpenChange={(open) => {
            if (!open && !removalPending) setRemoving(false);
          }}
          size="sm"
          title={`Remove ${shown}?`}
          description="Its tickets keep their last synced content, local work, and links to their issues. You can take ownership of a ticket to edit it here. Sync resumes if a connection discovers the issue again."
          primaryLabel={removalPending ? "Removing…" : "Remove connection"}
          primaryVariant="destructive"
          blockedReason={null}
          busy={removalPending}
          resolveReturnFocus={() => removeButton.current}
          error={
            removalFailure && (
              <FailureAlert size="compact" failure={removalFailure} />
            )
          }
          onSubmit={() => void remove()}
        />
      )}
    </SettingsSection>
  );
}
