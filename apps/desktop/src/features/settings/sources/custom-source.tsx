import { ChevronRight, Plus } from "lucide-react";
import { StatusLabel } from "@/components/ui/status-label";
import {
  SettingsList,
  SettingsRow,
  SettingsRowTile,
} from "@/features/settings/layout/SettingsList";
import { useAddCustomSource } from "@/features/settings/sources/use-add-custom-source";
import { homeRelative, withoutVerbatim } from "@/lib/paths";
import { type RegisteredExtension } from "@/lib/api/sources";
import "@/features/settings/sources/custom-source.css";

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
            <span className="cli-code">
              {homeRelative(withoutVerbatim(extension.origin))}
            </span>
          </dd>
        </>
      )}
    </dl>
  );
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
