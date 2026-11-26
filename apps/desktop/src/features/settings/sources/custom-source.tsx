import { useState, type ReactNode } from "react";
import { ChevronRight, Plus } from "lucide-react";
import { DialogShell } from "@/components/ui/dialog-shell";
import { PathText } from "@/components/ui/path-text";
import { StatusLabel } from "@/components/ui/status-label";
import {
  SettingsList,
  SettingsRow,
  SettingsRowTile,
} from "@/features/settings/layout/SettingsList";
import { describeFailure } from "@/lib/api/describe-failure";
import {
  sourcesClient,
  toSourceFailure,
  type ExtensionConsent,
  type RegisteredExtension,
} from "@/lib/api/sources";
import { workspaceClient } from "@/lib/api/workspace";
import "@/features/settings/sources/custom-source.css";

/** The refusals the core words itself, because they say what to fix in the folder. */
const REFUSALS: readonly string[] = [
  "not_a_folder",
  "no_manifest",
  "needs_newer_ticketd",
  "invalid_manifest",
];

/** "example-tracker" reads "Example tracker": the program's ID is all that is known before it runs. */
export function nameOfId(id: string): string {
  const words = id.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * What a program is, as the person reads it: the same four facts in the
 * consent and on the source's page.
 */
export function ProgramFacts({
  extension,
  fromLabel,
}: {
  extension: Pick<
    RegisteredExtension,
    "id" | "version" | "command" | "hosts" | "origin"
  >;
  fromLabel: "From" | "Added from";
}) {
  return (
    <dl className="cli-details program-facts">
      <dt>Source</dt>
      <dd>
        <span className="cli-code">{`${extension.id} ${extension.version}`}</span>
      </dd>
      <dt>Runs</dt>
      <dd>
        <span className="cli-code">{extension.command}</span>
      </dd>
      <dt>Connects to</dt>
      <dd>
        {extension.hosts.length > 0 ? (
          <span className="cli-code">{extension.hosts.join(", ")}</span>
        ) : (
          "No hosts declared"
        )}
      </dd>
      {extension.origin && (
        <>
          <dt>{fromLabel}</dt>
          <dd>
            <span className="cli-path">
              <PathText path={extension.origin} layout="inline" />
            </span>
          </dd>
        </>
      )}
    </dl>
  );
}

/**
 * Picks a folder, reads it without running it, and asks once. Adding approves
 * it the way `ticketd source extension add` does. A folder that cannot be added
 * says why in `refusal` and never opens the dialog.
 */
export function useAddCustomSource({
  expectId,
  onAdded,
}: {
  /** Adding again: only this source's folder is accepted. */
  expectId?: string;
  onAdded: (extension: RegisteredExtension) => void;
}): {
  choose: () => void;
  busy: boolean;
  refusal: string | null;
  dialog: ReactNode;
} {
  const [consent, setConsent] = useState<ExtensionConsent | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function choose() {
    setRefusal(null);
    setReading(true);
    try {
      const path = await workspaceClient.chooseFolder({
        title: expectId
          ? `Choose the folder of ${nameOfId(expectId)}`
          : "Choose the source’s folder",
      });
      if (path === null) return;
      const prepared = await sourcesClient.prepareExtension(path);
      if (expectId && prepared.extension.id !== expectId) {
        void sourcesClient.cancelExtension(prepared.token).catch(() => {});
        setRefusal(
          `This folder is ${prepared.extension.id}, not ${expectId}. Choose the folder of ${nameOfId(expectId)}.`,
        );
        return;
      }
      setFailure(null);
      setConsent(prepared);
    } catch (reason) {
      const problem = toSourceFailure(reason);
      setRefusal(
        REFUSALS.includes(problem.code)
          ? problem.message
          : describeFailure(problem, "read this folder").sentence,
      );
    } finally {
      setReading(false);
    }
  }

  function close() {
    if (adding) return;
    if (consent) void sourcesClient.cancelExtension(consent.token).catch(() => {});
    setConsent(null);
  }

  async function add(current: ExtensionConsent) {
    setAdding(true);
    setFailure(null);
    try {
      const added = await sourcesClient.addExtension(current.token);
      setConsent(null);
      onAdded(added);
    } catch (reason) {
      setFailure(describeFailure(reason, "add this source").sentence);
    } finally {
      setAdding(false);
    }
  }

  const dialog = consent && (
    <DialogShell
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={`Add ${nameOfId(consent.extension.id)} as a ticket source?`}
      description="It runs on this computer as you, with access to your files and the network."
      primaryLabel={adding ? "Adding…" : "Add source"}
      blockedReason={adding ? "Adding…" : null}
      footerNote="Add only programs you trust."
      busy={adding}
      error={failure}
      onSubmit={() => void add(consent)}
    >
      <SettingsList>
        <ProgramFacts extension={consent.extension} fromLabel="From" />
      </SettingsList>
    </DialogShell>
  );

  return {
    choose: () => void choose(),
    busy: reading || adding,
    refusal,
    dialog,
  };
}

/** The row on Ticket sources that starts adding a custom source. */
export function AddCustomSourceRow({
  onAdded,
}: {
  onAdded: (extension: RegisteredExtension) => void;
}) {
  const { choose, busy, refusal, dialog } = useAddCustomSource({ onAdded });
  return (
    <section className="settings-section">
      <SettingsList>
        <SettingsRow
          leading={
            <SettingsRowTile>
              <Plus />
            </SettingsRowTile>
          }
          title={
            <button
              type="button"
              className="custom-source-add"
              disabled={busy}
              onClick={choose}
            >
              Add a custom source
            </button>
          }
          description="A program built on ticketd’s ticket source contract, by you or someone else."
          trailing={
            <span className="custom-source-chevron" aria-hidden="true">
              <ChevronRight size={16} />
            </span>
          }
        />
        {refusal && (
          <SettingsRow
            description={
              <span role="alert">
                <StatusLabel tone="attention">{refusal}</StatusLabel>
              </span>
            }
          />
        )}
      </SettingsList>
      {dialog}
    </section>
  );
}
