import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import { SettingsCard } from "@/features/settings/SettingsCard";
import { useSourceActivity } from "@/features/tickets/source-activity";
import { ago } from "@/features/tickets/ticket-source";
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
import { SourceLink } from "@/features/tickets/SourceLink";
import { useNow } from "@/lib/use-now";
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

function PreviewPanel({
  preview,
  refresh,
  busy,
}: {
  preview: DiscoveryPreview;
  refresh: () => void;
  busy: boolean;
}) {
  return (
    <div className="source-preview" role="region" aria-label="Preview">
      <div className="source-preview-heading">
        <h3>
          Preview · {preview.complete ? "" : "at least "}
          {preview.matched}{" "}
          {preview.matched === 1 ? "issue matches" : "issues match"}
        </h3>
        {preview.new !== undefined && (
          <span className="settings-hint">
            {preview.new} new · {preview.already_here} already here
          </span>
        )}
        <Button variant="ghost" size="sm" disabled={busy} onClick={refresh}>
          Refresh preview
        </Button>
      </div>
      <p className="settings-hint">
        {preview.matched === 0
          ? "No open issues match these rules. You can still save them."
          : `Checked as ${preview.account}; nothing has been imported.`}{" "}
        Pull requests are not included.
        {preview.issues.length < preview.matched &&
          ` Showing the first ${preview.issues.length}.`}
      </p>
      {preview.issues.length > 0 && (
        <div className="source-preview-table-scroll">
          <table>
            <thead>
              <tr>
                <th>Issue</th>
                <th>Title</th>
                <th>In ticketd</th>
              </tr>
            </thead>
            <tbody>
              {preview.issues.map((issue) => (
                <tr key={issue.display}>
                  <td>
                    <SourceLink url={issue.url} className="source-preview-ref">
                      {issue.display.split("/").at(-1)}
                    </SourceLink>
                  </td>
                  <td>{issue.title}</td>
                  <td>
                    {issue.ticket ? (
                      <>
                        Already{" "}
                        <span className="source-number">{issue.ticket}</span>
                      </>
                    ) : (
                      "New · Todo"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** One available source: connection check, schema-driven rules, preview, then save. */
export function SourceCard({ entry }: { entry: SourceEntry }) {
  const now = useNow();
  const { connector } = entry;
  const schedule = useSourceActivity();
  const health = schedule.sources.find(
    (item) => item.provider === connector.provider,
  );
  const lastRefreshed = health?.last_refreshed_at;
  const syncing =
    health === undefined ||
    health.health === "synced" ||
    health.health === "waiting";
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
    <div className="source-settings" aria-label={`${connector.name} settings`}>
      <SettingsCard
        id={`source-${connector.provider}`}
        title="Connection"
        actions={
          <Button
            variant="ghost"
            size="sm"
            disabled={working}
            onClick={checkConnection}
          >
            {busy === "checking" ? "Checking…" : "Check connection"}
          </Button>
        }
        footer={
          <p className="settings-hint">
            Uses your own {connector.name} permissions. Routine sync only reads;
            ticketd writes to {connector.name} only when you publish a ticket.
          </p>
        }
      >
        <div className="source-connection-health">
          {connection ? (
            <p role="status">{connection}</p>
          ) : (
            <p className="settings-label source-health">
              <StatusDot
                tone={saved && syncing ? "positive" : "neutral"}
                size={10}
              />
              {saved ? `Connected as ${saved.account}` : "Not connected"}
            </p>
          )}
          {saved && health && !syncing && (
            <p
              className="settings-label source-health"
              data-health={health.health}
            >
              <StatusDot tone="attention" size={10} />
              {health.health === "unavailable"
                ? `${connector.name} is unavailable`
                : health.health === "delayed"
                  ? `${connector.name} refresh is delayed`
                  : `${connector.name} is partly refreshed`}
              {health.error ? `: ${health.error.message}` : ""}
            </p>
          )}
        </div>
      </SettingsCard>
      <SettingsCard
        id={`source-${connector.provider}-discovery`}
        title="Discovery"
        actions={
          <span className="settings-hint source-status" data-status={status}>
            <StatusDot tone={status === "unsaved" ? "attention" : "neutral"} />
            {status === "saved"
              ? "Saved configuration"
              : status === "unsaved"
                ? "Unsaved changes"
                : "Not configured"}
          </span>
        }
        footer={
          <>
            <p className="settings-hint">
              Runs when ticketd opens
              {schedule.intervalSecs
                ? ` and every ${Math.max(1, Math.round(schedule.intervalSecs / 60))} minutes while it is open`
                : " and periodically while it is open"}
              . An issue that stops matching stays in your workspace and keeps
              syncing.
            </p>
            <div className="settings-actions">
              <Button
                variant="ghost"
                size="sm"
                disabled={working || !dirty}
                onClick={() => {
                  latest.current += 1;
                  setDraft(draftFromConfig(fields, saved?.config));
                  setPreviewed(null);
                  setFailure(null);
                  setNotice("");
                }}
              >
                Discard changes
              </Button>
              <Button size="sm" disabled={!canSave} onClick={save}>
                {busy === "saving" ? "Saving…" : "Save"}
              </Button>
            </div>
          </>
        }
      >
        <p className="settings-hint">
          Choose the open issues to discover. Matching issues are imported as
          tickets on the next refresh. Nothing is changed in {connector.name}.
        </p>
        <SchemaForm
          fields={fields}
          draft={draft}
          errors={fieldErrors(failure)}
          disabled={working}
          loadOptions={loadOptions}
          onChange={edit}
        />
        {!preview && (
          <div className="settings-actions">
            <Button
              variant="ghost"
              size="sm"
              disabled={working}
              onClick={previewMatches}
            >
              {busy === "previewing" ? "Previewing…" : "Preview matches"}
            </Button>
          </div>
        )}
        {!preview && !working && (
          <p className="settings-hint">
            {saved && !dirty
              ? "These rules are the saved configuration."
              : stale
                ? "The rules changed. Preview matches again before saving."
                : "Preview the matching issues before saving."}
          </p>
        )}
        {failure && (
          <p role="alert" className="settings-failure">
            {failure.fields.length > 0
              ? "Fix the highlighted settings, then try again."
              : failure.message}
          </p>
        )}
        {notice && (
          <p className="settings-hint" role="status">
            {notice}
          </p>
        )}
        {preview && (
          <PreviewPanel
            preview={preview}
            refresh={() => void previewMatches()}
            busy={working}
          />
        )}
        {saved && status === "unsaved" && (
          <p className="settings-hint">
            The saved configuration from {formatDateTime(saved.saved_at)} still
            applies until you save.
          </p>
        )}
      </SettingsCard>
      <SettingsCard
        id={`source-${connector.provider}-sync`}
        title="Sync"
        actions={
          <Button
            variant="ghost"
            size="sm"
            disabled={schedule.refreshing}
            onClick={() => void schedule.refreshAll()}
          >
            Refresh now
          </Button>
        }
        footer={
          <p className="settings-hint">
            Agents can refresh without the desktop open:{" "}
            <code>ticketd source refresh</code>
          </p>
        }
      >
        <p className="settings-hint" role="status">
          {schedule.refreshing
            ? `Refreshing ${connector.name}…`
            : lastRefreshed
              ? `${syncing ? "Last refreshed" : "Last synced"} ${ago(lastRefreshed, now)}.`
              : "Not refreshed yet."}
        </p>
      </SettingsCard>
    </div>
  );
}
