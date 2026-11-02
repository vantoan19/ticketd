import { useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import { SettingsCard } from "@/features/settings/SettingsCard";
import {
  SchemaForm,
  type LoadOptions,
} from "@/features/settings/sources/SchemaForm";
import {
  configFromDraft,
  configKey,
  draftFromConfig,
  type Draft,
} from "@/features/settings/sources/config-values";
import { formatDateTime } from "@/lib/format";
import {
  sourcesClient,
  toSourceFailure,
  type DiscoveryPreview,
  type SavedSource,
  type SourceEntry,
  type SourceFailure,
} from "@/lib/api/sources";

type Busy = "checking" | "previewing" | "saving" | null;

function fieldErrors(failure: SourceFailure | null) {
  const grouped: Record<string, string[]> = {};
  for (const issue of failure?.fields ?? [])
    (grouped[issue.field] ??= []).push(issue.message);
  return grouped;
}

function PreviewPanel({ preview }: { preview: DiscoveryPreview }) {
  const count = preview.complete
    ? `${preview.matched} matching ${preview.matched === 1 ? "issue" : "issues"}`
    : `At least ${preview.matched} matching issues`;
  return (
    <div className="source-preview" role="region" aria-label="Preview">
      <p className="settings-label">
        {preview.matched === 0 ? "No open issues match these rules" : count}
      </p>
      <p className="settings-hint">
        {preview.matched === 0
          ? "You can still save these rules; matching issues will appear once they exist. Pull requests are never included."
          : `Checked as ${preview.account}. Pull requests are not included, and nothing has been imported.${
              preview.issues.length < preview.matched
                ? ` Showing the first ${preview.issues.length}.`
                : ""
            }`}
      </p>
      {preview.issues.length > 0 && (
        <ul className="source-preview-list">
          {preview.issues.map((issue) => (
            <li key={issue.display}>
              <span className="source-preview-ref">{issue.display}</span>
              <span className="source-preview-title">{issue.title}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One available source: connection check, schema-driven rules, preview, then save. */
export function SourceCard({ entry }: { entry: SourceEntry }) {
  const { connector } = entry;
  const fields = connector.schema.fields;
  const [saved, setSaved] = useState<SavedSource | null>(entry.saved);
  const [draft, setDraft] = useState<Draft>(() =>
    draftFromConfig(fields, entry.saved?.config),
  );
  const [busy, setBusy] = useState<Busy>(null);
  const [failure, setFailure] = useState<SourceFailure | null>(null);
  const [connection, setConnection] = useState("");
  const [previewed, setPreviewed] = useState<{
    key: string;
    preview: DiscoveryPreview;
  } | null>(null);
  const [notice, setNotice] = useState("");
  // A stale response must not overwrite a newer draft's outcome.
  const latest = useRef(0);

  const config = useMemo(() => configFromDraft(fields, draft), [fields, draft]);
  const key = configKey(config);
  const dirty =
    saved === null
      ? Object.keys(config).length > 0
      : key !== configKey(saved.config);
  const preview = previewed?.key === key ? previewed.preview : null;
  const stale = previewed !== null && previewed.key !== key;
  const working = busy !== null;
  const canSave = preview !== null && !working && (dirty || saved === null);

  const loadOptions: LoadOptions = (field, query) =>
    sourcesClient.options(connector.provider, field, query, config);

  function edit(fieldKey: string, value: string | string[]) {
    setDraft((current) => ({ ...current, [fieldKey]: value }));
    setNotice("");
    setFailure(null);
  }

  async function run<T>(
    kind: Exclude<Busy, null>,
    work: () => Promise<T>,
    done: (value: T) => void,
  ) {
    const request = ++latest.current;
    setBusy(kind);
    setFailure(null);
    setNotice("");
    try {
      const value = await work();
      if (request === latest.current) done(value);
    } catch (reason) {
      if (request === latest.current) setFailure(toSourceFailure(reason));
    } finally {
      if (request === latest.current) setBusy(null);
    }
  }

  const checkConnection = () =>
    run(
      "checking",
      () => sourcesClient.checkConnection(connector.provider, config),
      (info) => setConnection(`Connected as ${info.account}.`),
    );
  const previewMatches = () => {
    setConnection("");
    return run(
      "previewing",
      () => sourcesClient.preview(connector.provider, config),
      (result) => setPreviewed({ key, preview: result }),
    );
  };
  const save = () =>
    run(
      "saving",
      () => sourcesClient.save(connector.provider, config),
      (outcome) => {
        setSaved(outcome.source);
        setDraft(draftFromConfig(fields, outcome.source.config));
        setPreviewed({
          key: configKey(outcome.source.config),
          preview: outcome.preview,
        });
        setNotice(
          "Saved. Matching issues are imported on the next refresh, and then kept up to date automatically.",
        );
      },
    );

  const status =
    saved === null ? (dirty ? "unsaved" : "none") : dirty ? "unsaved" : "saved";

  return (
    <SettingsCard id={`source-${connector.provider}`} title={connector.name}>
      <p className="settings-hint">
        Choose which issues ticketd discovers. Saving turns discovery on:
        matching issues are imported as tickets on the next refresh and then
        refreshed automatically. Nothing is changed in {connector.name}.
      </p>
      <p className="settings-label source-status" data-status={status}>
        <StatusDot
          tone={
            status === "saved"
              ? "positive"
              : status === "unsaved"
                ? "attention"
                : "neutral"
          }
        />{" "}
        {status === "saved" && "Saved configuration"}
        {status === "unsaved" && "Unsaved changes"}
        {status === "none" && "Not configured"}
      </p>
      {saved && (
        <p className="settings-hint">
          {status === "unsaved"
            ? `The saved configuration from ${formatDateTime(saved.saved_at)} still applies until you save.`
            : `Validated as ${saved.account}, saved ${formatDateTime(saved.saved_at)}.`}
        </p>
      )}
      <SchemaForm
        fields={fields}
        draft={draft}
        errors={fieldErrors(failure)}
        disabled={working}
        loadOptions={loadOptions}
        onChange={edit}
      />
      <div className="settings-actions">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={working}
          onClick={checkConnection}
        >
          {busy === "checking" && (
            <Loader2 className="animate-spin" aria-hidden="true" />
          )}
          {busy === "checking" ? "Checking…" : "Check connection"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={working}
          onClick={previewMatches}
        >
          {busy === "previewing" && (
            <Loader2 className="animate-spin" aria-hidden="true" />
          )}
          {busy === "previewing" ? "Previewing…" : "Preview matches"}
        </Button>
        <Button type="button" size="sm" disabled={!canSave} onClick={save}>
          {busy === "saving" && (
            <Loader2 className="animate-spin" aria-hidden="true" />
          )}
          {busy === "saving" ? "Saving…" : "Save"}
        </Button>
      </div>
      {!preview && !working && (
        <p className="settings-hint">
          {stale
            ? "The rules changed. Preview matches again before saving."
            : "Preview the matching issues before saving."}
        </p>
      )}
      {connection && (
        <p className="settings-hint" role="status">
          {connection}
        </p>
      )}
      {failure && failure.fields.length === 0 && (
        <p role="alert" className="settings-failure">
          {failure.message}
        </p>
      )}
      {failure && failure.fields.length > 0 && (
        <p role="alert" className="settings-failure">
          Fix the highlighted settings, then try again.
        </p>
      )}
      {notice && (
        <p className="settings-hint" role="status">
          {notice}
        </p>
      )}
      {preview && <PreviewPanel preview={preview} />}
    </SettingsCard>
  );
}
