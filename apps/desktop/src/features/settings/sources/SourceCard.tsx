import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { AlignLeft, CircleDot, Link, RefreshCw, UserRound } from "lucide-react";
import { CommandBlock } from "@/components/ui/command-block";
import { FailureDetails } from "@/components/ui/failure-alert";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { StatusDot, type StatusDotTone } from "@/components/ui/status-dot";
import { StatusLabel } from "@/components/ui/status-label";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import {
  SettingsList,
  SettingsListFooter,
  SettingsRow,
  SettingsRowTile,
} from "@/features/settings/layout/SettingsList";
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
  type SourceConfig,
  type SourceFailure,
} from "@/lib/api/sources";

type Busy = "previewing" | "saving" | null;

/** What each command did not do, for its failure title. */
const STEP = {
  previewing: "preview matching issues",
  saving: "save the configuration",
} as const;

/**
 * The account check, apart from the saved rules (set SR-01): signed in as
 * someone, not signed in, or the check itself failed. Read when the page is
 * first shown and again on Check connection.
 */
type Account =
  | { status: "checking" }
  | { status: "signed_in"; account: string }
  | { status: "signed_out"; failure: FailureDescription }
  | { status: "failed"; failure: FailureDescription };

/** The core says these when the account itself is the problem. */
const SIGNED_OUT: readonly string[] = [
  "unauthenticated",
  "not_signed_in",
  "forbidden",
];

/**
 * What to do when the credential is missing or refused. Not signed in needs a
 * sign-in, not "connecting again", and the way to it is named.
 */
function signInStep(connector: SourceEntry["connector"]) {
  return connector.provider === "github"
    ? "Run “gh auth login” in a terminal, then choose Check connection."
    : `Sign in to ${connector.name} on this computer, then choose Check connection.`;
}

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
        <div className="source-preview-title">
          <h3>
            Preview · {preview.complete ? "" : "at least "}
            {preview.matched}{" "}
            {preview.matched === 1 ? "issue matches" : "issues match"}
          </h3>
          <p>
            {preview.new !== undefined && (
              <>
                <span>
                  {preview.new} new · {preview.already_here} already here
                </span>
                {" · "}
              </>
            )}
            {preview.matched === 0
              ? "No open issues match these rules. You can still save them."
              : `Checked as ${preview.account}; nothing has been imported.`}{" "}
            Pull requests are not included.
            {preview.issues.length < preview.matched &&
              ` Showing the first ${preview.issues.length}.`}
          </p>
        </div>
        <Button variant="ghost" size="sm" disabled={busy} onClick={refresh}>
          Refresh preview
        </Button>
      </div>
      {preview.issues.length > 0 && (
        <div className="source-preview-table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Issue</th>
                <th scope="col">Title</th>
                <th scope="col">In ticketd</th>
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
                      <StatusLabel tone="positive" size="caption">
                        Already{" "}
                        <span className="source-number">{issue.ticket}</span>
                      </StatusLabel>
                    ) : (
                      <StatusLabel tone="neutral" size="caption">
                        New · Todo
                      </StatusLabel>
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

/** "a, b and c": the last item joined by "and". */
function joinNames(items: string[]) {
  return items.length < 2
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * The GitHub draft in one sentence, so the rules can be read at a glance.
 * Clauses that do not apply are left out.
 */
function Readback({ config }: { config: SourceConfig }) {
  const list = (key: string) => {
    const value = config[key];
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  };
  const repositories = list("repositories");
  const labels = list("labels");
  const assignee =
    typeof config.assignee === "string" ? config.assignee.trim() : "";
  return (
    <SettingsListFooter>
      <span className="source-readback" data-testid="source-readback">
        <AlignLeft size={16} aria-hidden="true" />
        <span>
          Imports open issues from{" "}
          <strong>
            {repositories.length > 0
              ? repositories.join(", ")
              : "no repository yet"}
          </strong>
          {labels.length > 0 && (
            <>
              {" "}
              that have the {labels.length === 1 ? "label" : "labels"}{" "}
              <strong>{joinNames(labels)}</strong>
            </>
          )}
          , assigned to <strong>{assignee || "anyone"}</strong>.
        </span>
      </span>
    </SettingsListFooter>
  );
}

/**
 * One available source as a Settings page: connection check, schema-driven
 * rules, preview and sync. Save, Discard and Preview sit in a save bar that
 * sticks to the bottom of the panel, with the short state in the panel bar.
 */
export function SourceCard({
  entry,
  hidden = false,
}: {
  entry: SourceEntry;
  /** Keeps the page mounted but out of sight, so its draft and preview survive. */
  hidden?: boolean;
}) {
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
  const [failedStep, setFailedStep] = useState<Exclude<Busy, null>>("saving");
  const [account, setAccount] = useState<Account | null>(null);
  const checks = useRef(0);
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
  const repositories = config.repositories;
  const hasTarget = fields.some((field) => field.key === "repositories")
    ? Array.isArray(repositories) && repositories.length > 0
    : Object.keys(config).length > 0;
  const canPreview = !working && hasTarget;
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
      if (request === latest.current) {
        setFailedStep(kind);
        setFailure(toSourceFailure(reason));
      }
    } finally {
      if (request === latest.current) setBusy(null);
    }
  }

  async function checkAccount() {
    const request = ++checks.current;
    setAccount({ status: "checking" });
    let next: Account;
    try {
      const info = await sourcesClient.checkConnection(
        connector.provider,
        config,
      );
      next = { status: "signed_in", account: info.account };
    } catch (reason) {
      const failure = describeFailure(
        toSourceFailure(reason),
        `check your ${connector.name} account`,
      );
      next = SIGNED_OUT.includes(failure.code)
        ? { status: "signed_out", failure }
        : { status: "failed", failure };
    }
    if (request === checks.current) setAccount(next);
  }
  // Once, the first time the page is shown; Check connection asks again.
  const firstCheck = useEffectEvent(() => void checkAccount());
  const checked = useRef(false);
  useEffect(() => {
    if (hidden || checked.current) return;
    checked.current = true;
    firstCheck();
  }, [hidden]);
  const previewMatches = () =>
    run(
      "previewing",
      () => sourcesClient.preview(connector.provider, config),
      (result) => {
        setPreviewed({ key, preview: result });
        // The preview ran as this account: that answers the check too.
        checks.current += 1;
        setAccount({ status: "signed_in", account: result.account });
      },
    );
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
          "Saved. Matching issues are imported on the next sync, then kept up to date automatically.",
        );
      },
    );

  const status =
    saved === null ? (dirty ? "unsaved" : "none") : dirty ? "unsaved" : "saved";
  // The saved configuration is only shown as healthy while the source syncs.
  const savedTone: StatusDotTone = saved && syncing ? "positive" : "neutral";
  const ready = preview !== null && status === "unsaved";
  // The rules' state is said twice only: short in the panel bar, in full in
  // the save bar (set SR-02).
  const short = ready
    ? { tone: "positive" as const, text: "Ready to save" }
    : status === "unsaved"
      ? { tone: "attention" as const, text: "Unsaved changes" }
      : status === "saved"
        ? { tone: savedTone, text: "Saved configuration" }
        : { tone: "neutral" as const, text: "Not configured" };
  // The save bar already says to preview first; the form only explains the rest.
  const hint =
    preview || working
      ? null
      : saved && !dirty
        ? "These rules are the saved configuration."
        : stale
          ? "The rules changed. Preview matches again before saving."
          : null;
  const barText = notice
    ? notice
    : ready
      ? "Preview is current. Saving turns discovery on; matching issues are imported on the next sync."
      : status === "unsaved"
        ? "Unsaved changes. Preview the matching issues before saving."
        : status === "saved"
          ? "These rules are saved. Matching issues are kept up to date automatically."
          : "Not configured. Add a repository, then preview the matching issues.";
  // A failure that is not about one field is said where the next step is: the
  // save bar. Field problems stay under their fields (set SR-05).
  const barFailure =
    failure && failure.fields.length === 0
      ? describeFailure(failure, STEP[failedStep])
      : null;

  const discard = () => {
    latest.current += 1;
    setDraft(draftFromConfig(fields, saved?.config));
    setPreviewed(null);
    setFailure(null);
    setNotice("");
  };

  const saveBar = (
    <div className="source-save-bar" role="region" aria-label="Save changes">
      {barFailure ? (
        <div className="source-save-message" role="alert">
          <StatusLabel tone="attention" size="caption">
            {barFailure.title}
          </StatusLabel>
          <span>{barFailure.sentence}</span>
          <FailureDetails small details={barFailure.details} />
        </div>
      ) : (
        <p className="source-save-message" role="status">
          <StatusDot tone={short.tone} />
          {barText}
        </p>
      )}
      <Button
        variant="ghost"
        size="sm"
        disabled={working || !dirty}
        onClick={discard}
      >
        Discard changes
      </Button>
      {!preview && (
        <Button
          variant="outline"
          size="sm"
          disabled={!canPreview}
          onClick={previewMatches}
        >
          {busy === "previewing" ? "Previewing…" : "Preview matches"}
        </Button>
      )}
      <Button size="sm" disabled={!canSave} onClick={save}>
        {busy === "saving" ? "Saving…" : "Save"}
      </Button>
    </div>
  );

  const signedIn = account?.status === "signed_in" ? account.account : null;
  const accountLabel =
    account === null || account.status === "checking" ? (
      <span className="source-checking">
        Checking your {connector.name} account…
      </span>
    ) : account.status === "signed_in" ? (
      <StatusLabel tone="positive">Signed in as {account.account}</StatusLabel>
    ) : account.status === "signed_out" ? (
      <StatusLabel tone="attention">
        Not signed in to {connector.name}
      </StatusLabel>
    ) : (
      <StatusLabel tone="attention">
        Couldn't check your {connector.name} account
      </StatusLabel>
    );
  const accountFailure =
    account?.status === "signed_out" || account?.status === "failed"
      ? account.failure
      : null;
  // Missing credentials are one fact told once, on the account row, with the
  // way to fix it. The sync health row repeats it only when the account has
  // not been found signed out itself.
  const needsSignIn = (code: string) =>
    code === "unauthenticated" || code === "not_signed_in";
  const accountSentence =
    accountFailure && needsSignIn(accountFailure.code)
      ? signInStep(connector)
      : accountFailure?.sentence;
  const healthSentence = health?.error
    ? needsSignIn(health.error.code)
      ? signInStep(connector)
      : describeFailure(
          { code: health.error.code, message: health.error.message },
          `sync ${connector.name}`,
        ).sentence
    : undefined;
  const healthRepeatsAccount =
    account?.status === "signed_out" &&
    !!health?.error &&
    SIGNED_OUT.includes(health.error.code);

  return (
    <SettingsPage
      group="Connections"
      label={connector.name}
      icon={CircleDot}
      lede={`Bring matching ${connector.name} issues into this workspace. Their title, description, state and comments sync inward; ${connector.name} stays the place to edit them.`}
      endSlot={
        <StatusLabel tone={short.tone} size="caption">
          {short.text}
        </StatusLabel>
      }
      footer={saveBar}
      hidden={hidden}
    >
      <SettingsSection
        title="Connection"
        actions={
          <Button
            variant="outline"
            size="sm"
            disabled={account?.status === "checking"}
            onClick={() => void checkAccount()}
          >
            {account?.status === "checking" ? "Checking…" : "Check connection"}
          </Button>
        }
      >
        <SettingsList>
          {/* Two facts, two rows: whether this workspace is connected (saved
              rules, as the ticket menu means it), and whose account the
              check reached (set SR-01). */}
          <SettingsRow
            leading={
              <SettingsRowTile>
                <Link />
              </SettingsRowTile>
            }
            title={
              <StatusLabel tone={savedTone}>
                {saved
                  ? `${account?.status === "signed_out" ? "Saved for" : "Connected as"} ${saved.account}`
                  : "Not connected"}
              </StatusLabel>
            }
            description={
              saved
                ? `Routine sync only reads; ticketd writes to ${connector.name} only when you publish a ticket.`
                : `Save discovery rules below to connect this workspace. Until then tickets can't be published to ${connector.name}.`
            }
          />
          <SettingsRow
            leading={
              <SettingsRowTile>
                <UserRound />
              </SettingsRowTile>
            }
            title={<span role="status">{accountLabel}</span>}
            description={
              accountSentence
                ? accountSentence
                : signedIn
                  ? `ticketd uses your own ${connector.name} permissions.`
                  : `ticketd uses your own ${connector.name} sign-in and permissions.`
            }
            trailing={
              accountFailure?.details ? (
                <FailureDetails small details={accountFailure.details} />
              ) : undefined
            }
          />
          {saved && health && !syncing && !healthRepeatsAccount && (
            <SettingsRow
              title={
                <StatusLabel tone="attention">
                  <span data-health={health.health}>
                    {health.health === "unavailable"
                      ? `${connector.name} is unavailable`
                      : health.health === "delayed"
                        ? `${connector.name} sync is delayed`
                        : `${connector.name} is partly synced`}
                  </span>
                </StatusLabel>
              }
              description={healthSentence}
              trailing={
                health.error && (
                  <FailureDetails small details={health.error.message} />
                )
              }
            />
          )}
        </SettingsList>
      </SettingsSection>
      <SettingsSection
        title="Discovery"
        caption={`Choose the open issues to discover. Matching issues are imported as tickets on the next sync. Nothing is changed in ${connector.name}.`}
      >
        <SettingsList>
          <SettingsRow variant="stacked">
            <SchemaForm
              fields={fields}
              draft={draft}
              errors={fieldErrors(failure)}
              disabled={working}
              loadOptions={loadOptions}
              onChange={edit}
            />
            {hint && <p className="source-form-note">{hint}</p>}
            {saved && status === "unsaved" && (
              <p className="source-form-note">
                The saved configuration from {formatDateTime(saved.saved_at)}{" "}
                still applies until you save.
              </p>
            )}
          </SettingsRow>
          {connector.provider === "github" && <Readback config={config} />}
          {preview && (
            <PreviewPanel
              preview={preview}
              refresh={() => void previewMatches()}
              busy={working}
            />
          )}
        </SettingsList>
      </SettingsSection>
      <SettingsSection
        title="Sync"
        actions={
          <Button
            variant="ghost"
            size="sm"
            disabled={schedule.refreshing || saved === null}
            onClick={() => void schedule.refreshAll()}
          >
            <RefreshCw aria-hidden="true" />
            Sync now
          </Button>
        }
      >
        <SettingsList>
          <SettingsRow
            title={
              <span role="status">
                {schedule.refreshing
                  ? `Syncing ${connector.name}…`
                  : lastRefreshed
                    ? `${syncing ? "Synced" : "Last synced"} ${ago(lastRefreshed, now) ?? formatDateTime(lastRefreshed)}${health?.last_checked_tickets != null ? ` · ${health.last_checked_tickets} ${connector.name} ${health.last_checked_tickets === 1 ? "ticket" : "tickets"} checked` : ""}`
                    : "Not synced yet"}
              </span>
            }
            description={`Runs when ticketd opens${
              schedule.intervalSecs
                ? ` and every ${Math.max(1, Math.round(schedule.intervalSecs / 60))} minutes while it is open`
                : " and periodically while it is open"
            }. An issue that stops matching stays in your workspace and keeps syncing.`}
          />
          <SettingsRow
            variant="stacked"
            description="Agents can sync without the desktop open"
          >
            <CommandBlock
              command="ticketd source refresh"
              copyLabel="Copy sync command"
            />
          </SettingsRow>
        </SettingsList>
      </SettingsSection>
    </SettingsPage>
  );
}
