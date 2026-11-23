import {
  Fragment,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { AlignLeft, CircleDot, Link, RefreshCw, UserRound } from "lucide-react";
import { CommandBlock } from "@/components/ui/command-block";
import { DialogShell } from "@/components/ui/dialog-shell";
import { FailureDetails } from "@/components/ui/failure-alert";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { StatusDot, type StatusDotTone } from "@/components/ui/status-dot";
import { StatusLabel } from "@/components/ui/status-label";
import { SourceIcon } from "./SourceIcon";
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
  activeFields,
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
  type SummaryPart,
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
const NO_SECRETS: readonly string[] = [];
const SESSION_NOTICE =
  "The system keyring is unavailable. These credentials last until ticketd closes.";

function CredentialDialog({
  entry,
  saved,
  onClose,
  onSaved,
}: {
  entry: SourceEntry;
  saved: SavedSource & { id: string };
  onClose: () => void;
  onSaved: (saved: SavedSource) => void;
}) {
  const fields = entry.connector.schema.fields;
  const [draft, setDraft] = useState(() =>
    draftFromConfig(fields, saved.config),
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<SourceFailure | null>(null);
  const stored = saved.secret_fields ?? NO_SECRETS;
  const visible = activeFields(fields, draft, stored);
  const config = configFromDraft(fields, draft, stored);
  const credentials = Object.fromEntries(
    visible
      .filter(
        (field) => field.type === "secret" && Object.hasOwn(config, field.key),
      )
      .map((field) => [field.key, config[field.key]]),
  );
  const errors = new Map<string, string[]>();
  const formErrors: string[] = [];
  for (const { field, message } of failure?.fields ?? []) {
    if (
      field &&
      visible.some(
        (setting) => setting.key === field && setting.type === "secret",
      )
    ) {
      errors.set(field, [...(errors.get(field) ?? []), message]);
    } else {
      formErrors.push(field ? `${field} ${message}` : message);
    }
  }
  async function save() {
    setBusy(true);
    setFailure(null);
    try {
      onSaved(await sourcesClient.signIn(saved.id, credentials));
    } catch (reason) {
      setFailure(toSourceFailure(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <DialogShell
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Re-enter credentials"
      description={`Update the credentials for ${saved.name ?? entry.connector.name}.`}
      primaryLabel={busy ? "Saving…" : "Save credentials"}
      blockedReason={
        busy
          ? "Checking credentials…"
          : Object.keys(credentials).length === 0
            ? "Enter a credential to save."
            : null
      }
      onSubmit={() => void save()}
      busy={busy}
      error={failure && failure.fields.length === 0 ? failure.message : null}
    >
      <SchemaForm
        fields={fields}
        presentation={entry.connector.presentation?.fields}
        draft={draft}
        storedSecrets={stored}
        secretsOnly
        errors={Object.fromEntries(errors)}
        formErrors={formErrors}
        disabled={busy}
        loadOptions={async () => []}
        onChange={(field, value) => {
          setDraft((current) => ({ ...current, [field]: value }));
          setFailure(null);
        }}
      />
    </DialogShell>
  );
}

/**
 * What to do when the credential is missing or refused. Not signed in needs a
 * sign-in, not "connecting again", and the way to it is named.
 */
function signInStep(connector: SourceEntry["connector"]) {
  return (
    connector.presentation?.sign_in.desktop_instruction ??
    `Sign in to ${connector.name} on this computer, then choose Check connection.`
  );
}

function PreviewPanel({
  preview,
  discoveryNote,
  refresh,
  busy,
}: {
  preview: DiscoveryPreview;
  discoveryNote: string | null | undefined;
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
              : `Checked as ${preview.account}; nothing has been imported.`}
            {discoveryNote && ` ${discoveryNote}`}
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
                      {issue.label ?? issue.display}
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

function Readback({ parts }: { parts: SummaryPart[] }) {
  return (
    <SettingsListFooter>
      <span className="source-readback" data-testid="source-readback">
        <AlignLeft size={16} aria-hidden="true" />
        <span>
          {parts.map(({ text, emphasis }, index) => (
            <Fragment key={index}>
              {emphasis ? <strong>{text}</strong> : text}
            </Fragment>
          ))}
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
  adding,
}: {
  entry: SourceEntry;
  adding?: {
    id: string;
    onAdded: (source: SavedSource) => void;
    onCancel: () => void;
  };
  /** Keeps the page mounted but out of sight, so its draft and preview survive. */
  hidden?: boolean;
}) {
  const now = useNow();
  const { connector } = entry;
  const { presentation, provider } = connector;
  const [saved, setSaved] = useState<SavedSource | null>(entry.saved);
  const [name, setName] = useState(connector.name);
  const connectionId = adding?.id ?? saved?.id;
  const publishes = connector.capabilities.includes("publish");
  const syncedFields = connector.capabilities.includes("comments")
    ? "title, description, state and comments"
    : "title, description and state";
  const schedule = useSourceActivity();
  const health = schedule.sources.find((item) =>
    connectionId
      ? item.connection_id === connectionId
      : item.provider === provider,
  );
  const lastRefreshed = health?.last_refreshed_at;
  const retry = health?.error?.code === "extension_crash_limit";
  const syncing =
    health === undefined ||
    health.health === "synced" ||
    health.health === "waiting";
  const fields = connector.schema.fields;
  const [draft, setDraft] = useState<Draft>(() =>
    draftFromConfig(fields, entry.saved?.config),
  );
  const [busy, setBusy] = useState<Busy>(null);
  const [failure, setFailure] = useState<SourceFailure | null>(null);
  const [failedStep, setFailedStep] = useState<Exclude<Busy, null>>("saving");
  const [account, setAccount] = useState<Account | null>(null);
  const [signIn, setSignIn] = useState(false);
  const checks = useRef(0);
  const [previewed, setPreviewed] = useState<{
    key: string;
    preview: DiscoveryPreview;
  } | null>(null);
  const [notice, setNotice] = useState("");
  // A stale response must not overwrite a newer draft's outcome.
  const latest = useRef(0);

  const storedSecrets = saved?.secret_fields ?? NO_SECRETS;
  const config = useMemo(
    () => configFromDraft(fields, draft, storedSecrets),
    [fields, draft, storedSecrets],
  );
  const key = configKey(config);
  const publicConfig = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(config).filter(
          ([key]) =>
            !fields.some(
              (field) => field.key === key && field.type === "secret",
            ),
        ),
      ),
    [config, fields],
  );
  const publicKey = configKey(publicConfig);
  const [readback, setReadback] = useState<{
    key: string;
    parts: SummaryPart[];
  } | null>(null);
  useEffect(() => {
    if (hidden) return;
    let current = true;
    void sourcesClient.configurationSummary(provider, publicConfig).then(
      (parts) => {
        if (current) setReadback({ key: publicKey, parts });
      },
      () => {
        if (current) setReadback(null);
      },
    );
    return () => {
      current = false;
    };
  }, [publicConfig, hidden, publicKey, provider]);
  const dirty =
    saved === null
      ? Object.keys(config).length > 0
      : key !== configKey(saved.config);
  const preview = previewed?.key === key ? previewed.preview : null;
  const stale = previewed !== null && previewed.key !== key;
  const working = busy !== null;
  const targetField = presentation?.target;
  const target = targetField ? config[targetField.field] : undefined;
  const visible = activeFields(fields, draft, storedSecrets);
  const hasTarget =
    !visible.some((field) => field.key === targetField?.field) ||
    ((Array.isArray(target) || typeof target === "string") &&
      target.length > 0);
  const secretDeclared = visible.some((field) => field.type === "secret");
  const canPreview = !working && hasTarget;
  const canSave =
    preview !== null &&
    !working &&
    (dirty || saved === null) &&
    (!adding || name.trim().length > 0);
  const fieldErrors = new Map<string, string[]>();
  const formErrors: string[] = [];
  for (const { field, message } of failure?.fields ?? []) {
    const visibleField =
      field && visible.find((setting) => setting.key === field);
    if (visibleField && visibleField.type !== "link") {
      fieldErrors.set(visibleField.key, [
        ...(fieldErrors.get(visibleField.key) ?? []),
        message,
      ]);
    } else {
      formErrors.push(field ? `${field} ${message}` : message);
    }
  }

  const loadOptions: LoadOptions = (field, query) =>
    sourcesClient.options(
      connector.provider,
      field,
      query,
      config,
      connectionId,
    );

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
        connectionId,
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
  const [syncingNow, setSyncingNow] = useState(false);
  async function refreshConnection(id: string) {
    setSyncingNow(true);
    try {
      const report = await (retry
        ? sourcesClient.refresh(undefined, id, true)
        : sourcesClient.refresh(undefined, id));
      if (report.failures.length > 0) throw report.failures[0];
    } catch (reason) {
      setNotice(describeFailure(reason, "sync this connection").sentence);
    } finally {
      setSyncingNow(false);
    }
  }
  const previewMatches = () =>
    run(
      "previewing",
      () => sourcesClient.preview(connector.provider, config, connectionId),
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
      () =>
        adding
          ? sourcesClient.add(connector.provider, adding.id, name, config)
          : sourcesClient.save(connector.provider, config, connectionId),
      (outcome) => {
        setSaved(outcome.source);
        adding?.onAdded(outcome.source);
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
          : `Not configured. ${targetField?.add ?? "Enter discovery rules"}, then preview the matching issues.`;
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
      {adding ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={working}
          onClick={adding.onCancel}
        >
          Cancel
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          disabled={working || !dirty}
          onClick={discard}
        >
          Discard changes
        </Button>
      )}
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
        {busy === "saving" ? "Saving…" : adding ? "Add connection" : "Save"}
      </Button>
    </div>
  );

  const signedIn = account?.status === "signed_in" ? account.account : null;
  const credentialRecovery =
    saved?.id &&
    secretDeclared &&
    (account?.status === "signed_out" ||
      SIGNED_OUT.includes(health?.error?.code ?? ""));
  const accountLabel = credentialRecovery ? (
    <StatusLabel tone="attention">Needs sign-in</StatusLabel>
  ) : account === null || account.status === "checking" ? (
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
  const accountSentence = credentialRecovery
    ? "Re-enter the credentials for this connection."
    : accountFailure && needsSignIn(accountFailure.code)
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
    (credentialRecovery || account?.status === "signed_out") &&
    !!health?.error &&
    SIGNED_OUT.includes(health.error.code);

  return (
    <SettingsPage
      group="Connections"
      label={
        adding
          ? `Add ${connector.name} connection`
          : (entry.saved?.name ?? connector.name)
      }
      icon={CircleDot}
      iconContent={<SourceIcon svg={presentation?.icon_svg} />}
      titleAccessory={
        entry.development && <Badge variant="experimental">Development</Badge>
      }
      lede={`Bring matching ${connector.name} issues into this workspace. Their ${syncedFields} sync inward; ${connector.name} stays the place to edit them.`}
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
          {adding && (
            <SettingsRow variant="stacked">
              <Field>
                <FieldLabel htmlFor="source-connection-name">
                  Connection name
                </FieldLabel>
                <Input
                  id="source-connection-name"
                  maxLength={100}
                  value={name}
                  disabled={working}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
            </SettingsRow>
          )}
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
                ? publishes
                  ? `Routine sync only reads; ticketd writes to ${connector.name} only when you publish a ticket.`
                  : `Routine sync only reads from ${connector.name}.`
                : publishes
                  ? `Save discovery rules below to connect this workspace. Until then tickets can't be published to ${connector.name}.`
                  : "Save discovery rules below to connect this workspace."
            }
          />
          {!!presentation?.hosts?.length && (
            <SettingsRow
              title="Declared hosts"
              description={presentation.hosts.join(", ")}
            />
          )}
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
              credentialRecovery ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setSignIn(true)}
                >
                  Re-enter credentials
                </Button>
              ) : accountFailure?.details ? (
                <FailureDetails small details={accountFailure.details} />
              ) : undefined
            }
          />
          {!!saved?.session_secret_fields?.length && (
            <SettingsRow
              description={<span role="status">{SESSION_NOTICE}</span>}
            />
          )}
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
              presentation={presentation?.fields}
              targetField={targetField?.field}
              draft={draft}
              storedSecrets={storedSecrets}
              errors={Object.fromEntries(fieldErrors)}
              formErrors={formErrors}
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
          {readback?.key === publicKey && readback.parts.length > 0 && (
            <Readback parts={readback.parts} />
          )}
          {preview && (
            <PreviewPanel
              preview={preview}
              discoveryNote={presentation?.discovery_note}
              refresh={() => void previewMatches()}
              busy={working}
            />
          )}
        </SettingsList>
      </SettingsSection>
      {signIn && saved?.id && (
        <CredentialDialog
          entry={entry}
          saved={{ ...saved, id: saved.id }}
          onClose={() => setSignIn(false)}
          onSaved={(updated) => {
            setSignIn(false);
            setSaved(updated);
            setAccount({ status: "signed_in", account: updated.account });
          }}
        />
      )}
      <SettingsSection
        title="Sync"
        actions={
          <Button
            variant="ghost"
            size="sm"
            disabled={schedule.refreshing || syncingNow || saved === null}
            onClick={() =>
              void (connectionId
                ? refreshConnection(connectionId)
                : schedule.refreshAll())
            }
          >
            <RefreshCw aria-hidden="true" />
            {retry ? "Retry" : "Sync now"}
          </Button>
        }
      >
        <SettingsList>
          <SettingsRow
            title={
              <span role="status">
                {schedule.refreshing || syncingNow
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
              command={`ticketd source ${connectionId ?? "CONNECTION"} refresh`}
              copyLabel="Copy sync command"
            />
          </SettingsRow>
        </SettingsList>
      </SettingsSection>
    </SettingsPage>
  );
}
