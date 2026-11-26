import { useEffect, useRef, useState } from "react";
import { Check, Cloud, Download, ExternalLink, Upload } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ChoiceTile, ChoiceTiles } from "@/components/ui/choice-tiles";
import { DialogShell } from "@/components/ui/dialog-shell";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusLabel } from "@/components/ui/status-label";
import {
  SettingsList,
  SettingsListFooter,
  SettingsRow,
  SettingsRowTile,
} from "@/features/settings/layout/SettingsList";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { attachments } from "@/lib/api/attachments";
import { workspaceClient } from "@/lib/api/workspace";
import {
  syncApi,
  type SyncSetupOptions,
  type SyncStatus,
} from "@/lib/sync-api";
import { useNow } from "@/lib/use-now";
import { S3Setup } from "./S3Setup";
import { UseAnotherAccountDialog } from "./UseAnotherAccountDialog";
import { SyncFailure as Failure } from "./SyncFailure";
import { storageName } from "./storage-name";
import {
  contents,
  lastSynced,
  placeOf,
  plural,
  replacesHere,
} from "./sync-words";
import { useCommand } from "./use-sync-command";
import "@/features/settings/settings.css";
import "@/features/settings/restore-review.css";
import "@/features/settings/pages/attachments.css";
import "./sync.css";

/**
 * What the person said in step 1. It only matters in step 3 when the storage
 * holds no Workspace: Start then goes straight to the first sync. A Workspace
 * in the storage always preselects Join, whatever was said here.
 */
export type SetupIntent = "start" | "join";

const START = "start";
const RECONNECT = "reconnect";

/**
 * Steps 1 and 2 of setup, before anything is connected: whether this computer
 * starts a Workspace or joins one, then where it syncs. Nothing is written
 * anywhere until a connect button is pressed, and nothing is written to the
 * storage until step 3's choice.
 */
export function SyncSetup({
  intent,
  onIntent,
}: {
  intent: SetupIntent | null;
  onIntent: (intent: SetupIntent) => void;
}) {
  // Coming back from step 3 lands on where it syncs: the person already chose.
  const [step, setStep] = useState<1 | 2>(intent ? 2 : 1);
  return step === 1 ? (
    <StartOrJoin
      intent={intent}
      onIntent={onIntent}
      onContinue={() => setStep(2)}
    />
  ) : (
    <WhereItSyncs onBack={() => setStep(1)} />
  );
}

const WITH_SYNC = [
  "The same Workspace on each computer",
  "A copy in your own Google Drive or S3",
];
const WITHOUT_SYNC = [
  "Everything works here, offline too",
  "Restore points are still saved every day",
];

/** Step 1: what sync adds, and starting a Workspace or joining the one already synced. */
function StartOrJoin({
  intent,
  onIntent,
  onContinue,
}: {
  intent: SetupIntent | null;
  onIntent: (intent: SetupIntent) => void;
  onContinue: () => void;
}) {
  // What this computer holds, read once: it sets the default and what joining replaces.
  const [held, setHeld] = useState<
    { tickets: number; documents: number } | "unknown" | null
  >(null);
  useEffect(() => {
    let current = true;
    workspaceClient
      .info()
      .then((info) => {
        if (current)
          setHeld({ tickets: info.tickets, documents: info.documents });
      })
      .catch(() => {
        // Without the counts Start is the default that replaces nothing.
        if (current) setHeld("unknown");
      });
    return () => {
      current = false;
    };
  }, []);
  const counts = held && held !== "unknown" ? held : null;
  const empty = counts !== null && counts.tickets + counts.documents === 0;
  const chosen: SetupIntent = intent ?? (empty ? "join" : "start");
  const replaces = counts ? replacesHere(counts) : null;
  return (
    <>
      <div className="settings-section">
        <SettingsList>
          <div className="backups-contains">
            {[
              { heading: "With sync", items: WITH_SYNC },
              { heading: "Without sync", items: WITHOUT_SYNC },
            ].map(({ heading, items }) => (
              <div key={heading} className="backups-contains-column">
                <p className="backups-contains-heading">{heading}</p>
                <ul aria-label={heading}>
                  {items.map((item) => (
                    <li key={item}>
                      <Check size={16} aria-hidden="true" />
                      <span>
                        <span className="backups-contains-title">{item}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </SettingsList>
      </div>
      <SettingsSection
        title="Start or join"
        caption="Two Workspaces can't be merged later, so join the one you already sync."
      >
        {held === null ? (
          <div role="status" aria-label="Reading this computer">
            <Skeleton className="h-16 w-full" />
          </div>
        ) : (
          <ChoiceTiles
            variant="rows"
            aria-label="Start or join"
            value={chosen}
            onValueChange={(value) => onIntent(value as SetupIntent)}
          >
            <ChoiceTile
              value="start"
              title="Start with this Workspace"
              description="Your other computers join it later."
            />
            <ChoiceTile
              value="join"
              title="Join from another computer"
              description="Bring the Workspace you already sync here."
            >
              {replaces && (
                <span className="attachments-facts">{replaces}</span>
              )}
            </ChoiceTile>
          </ChoiceTiles>
        )}
      </SettingsSection>
      <div className="sync-footer">
        <SettingsList>
          <SettingsListFooter
            actions={
              <Button
                size="sm"
                disabled={held === null}
                onClick={() => {
                  onIntent(chosen);
                  onContinue();
                }}
              >
                Continue
              </Button>
            }
          >
            Nothing leaves this computer until you connect.
          </SettingsListFooter>
        </SettingsList>
      </div>
    </>
  );
}

type Storage = "google_drive" | "s3";

/** Step 2: Google Drive or S3, and signing in to it. */
function WhereItSyncs({ onBack }: { onBack: () => void }) {
  const { busy, failure, run } = useCommand();
  const [storage, setStorage] = useState<Storage>("google_drive");
  // Whether this build has a Google Drive app configuration. Unknown until
  // read; only a plain "no" holds back the button.
  const [configured, setConfigured] = useState<boolean | null>(null);
  useEffect(() => {
    let current = true;
    void attachments
      .driveConfiguration()
      .then((config) => {
        if (current) setConfigured(config.configured);
      })
      .catch(() => {
        // Sign-in still reports why it cannot start.
      });
    return () => {
      current = false;
    };
  }, []);
  return (
    <>
      <SettingsSection
        title="Where it syncs"
        caption="Use the same one on each computer."
      >
        <ChoiceTiles
          variant="rows"
          aria-label="Where it syncs"
          value={storage}
          disabled={busy}
          onValueChange={(value) => setStorage(value as Storage)}
        >
          <ChoiceTile
            value="google_drive"
            title="Google Drive"
            description="Signs in with your Google account, the same sign-in Files uses."
          />
          <ChoiceTile
            value="s3"
            title="S3"
            description="Signs in with a profile from your AWS CLI."
          />
        </ChoiceTiles>
      </SettingsSection>
      {storage === "s3" ? (
        <S3Setup onBack={onBack} />
      ) : (
        <>
          <div className="sync-footer">
            <SettingsList>
              <SettingsListFooter
                actions={
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={onBack}
                    >
                      Back
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy || configured === false}
                      onClick={() =>
                        void run(syncApi.connect, "connect Google Drive")
                      }
                    >
                      Connect Google Drive
                      <ExternalLink aria-hidden="true" />
                    </Button>
                  </>
                }
              >
                Files in your Drive are readable, not encrypted.
              </SettingsListFooter>
            </SettingsList>
          </div>
          {busy && (
            <p role="status" className="sync-status-line sync-waiting">
              Waiting for sign-in in your browser…
            </p>
          )}
          {configured === false && (
            <Alert role="status" className="mt-3">
              <AlertTitle>
                Google Drive isn't set up on this computer
              </AlertTitle>
              <AlertDescription>
                This build of ticketd has no Google Drive app configuration, so
                sign-in can't start. Install a build with Google Drive enabled.
                Your local files are unaffected.
              </AlertDescription>
            </Alert>
          )}
          <Failure>{failure}</Failure>
        </>
      )}
    </>
  );
}

/**
 * Step 3: what the storage already holds, read before anything is written.
 * A Workspace there is joined by default, even when this computer holds
 * tickets; starting a separate one is the second option, never preselected.
 */
export function Choose({
  status,
  intent,
  onDownloaded,
  onReplaced,
}: {
  status: SyncStatus;
  /** What step 1 said; unknown when the app was reopened here. */
  intent: SetupIntent | null;
  /** Told where the safety backup of the replaced Workspace is. */
  onDownloaded: (safetyBackup: string) => void;
  onReplaced: () => Promise<void>;
}) {
  const now = useNow();
  const { busy, failure, run } = useCommand();
  const [options, setOptions] = useState<SyncSetupOptions | null>(null);
  const [readFailure, setReadFailure] = useState<FailureDescription | null>(
    null,
  );
  const provider = status.provider;
  // Read again when the person asks, once what the failure said is fixed.
  const [attempt, setAttempt] = useState(0);
  const [choice, setChoice] = useState(START);
  const [confirming, setConfirming] = useState(false);
  const [switching, setSwitching] = useState(false);
  useEffect(() => {
    let current = true;
    syncApi
      .setupOptions()
      .then((read) => {
        if (!current) return;
        setOptions(read);
        // The folder this Workspace synced with is where it goes back to.
        // Failing that, a Workspace in the storage is what the person came
        // for, even with tickets here: starting another would split it.
        const [first] = read.existing;
        if (read.reconnect) setChoice(RECONNECT);
        else if (first) setChoice(first.folder_id);
        else setChoice(START);
      })
      .catch((reason: unknown) => {
        if (current)
          // The bucket check words its refusals for people: say what to fix.
          setReadFailure(
            describeFailure(reason, `read ${placeOf(provider)}`, {
              readable: provider === "s3",
            }),
          );
      });
    return () => {
      current = false;
    };
  }, [provider, attempt]);
  const download = options?.existing.find(
    (workspace) => workspace.folder_id === choice,
  );
  const account = status.account ?? "this account";
  const s3 = status.provider === "s3";
  const place = placeOf(status.provider);
  const storage = storageName(status.provider);
  const holdsWorkspace =
    !!options && (options.existing.length > 0 || !!options.reconnect);
  const startsAlone = !!options && !holdsWorkspace;
  const startSync = () => run(syncApi.uploadWorkspace, "start sync");
  // Start, with nothing in the storage to join: straight on to the first sync.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (startsAlone && intent === "start" && !autoStarted.current) {
      autoStarted.current = true;
      void startSync();
    }
    // `startSync` only closes over `run`, which keeps no state of its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startsAlone, intent]);
  const replaces = options ? replacesHere(options.local) : null;
  const where = s3 ? "bucket" : "Drive";
  return (
    <>
      <div className="sync-block">
        <SettingsList>
          <SettingsRow
            leading={
              <SettingsRowTile>
                <Cloud size={20} />
              </SettingsRowTile>
            }
            title={<StatusLabel tone="positive">Signed in</StatusLabel>}
            description={`${account} · ${s3 && status.s3 ? status.s3.bucket : storage.full}`}
            trailing={
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setSwitching(true)}
              >
                {s3 ? "Use another bucket…" : "Use another account…"}
              </Button>
            }
          />
        </SettingsList>
      </div>
      {!options && !readFailure && (
        <p role="status" className="settings-hint">
          {s3
            ? "Checking the bucket and looking for Workspaces…"
            : "Looking for Workspaces in your Drive…"}
        </p>
      )}
      {options && holdsWorkspace && (
        <SettingsSection
          title={
            options.existing.length > 1
              ? `Your ${where} already has Workspaces`
              : `Your ${where} already has a Workspace`
          }
          caption={
            options.existing.length > 1
              ? "Join one so this computer and your others share one Workspace."
              : "Join it so this computer and your others share one Workspace."
          }
        >
          <ChoiceTiles
            variant="rows"
            aria-label="This Workspace"
            value={choice}
            disabled={busy}
            onValueChange={setChoice}
          >
            {options.reconnect && (
              <ChoiceTile
                value={RECONNECT}
                title={`Reconnect to “${options.reconnect.name}”`}
                description={`Changes made here and in ${place} are merged, and nothing is replaced`}
              />
            )}
            {options.existing.map((workspace) => {
              const synced = lastSynced(workspace.last_synced_at, now);
              return (
                <ChoiceTile
                  key={workspace.folder_id}
                  value={workspace.folder_id}
                  title={`Join “${workspace.folder_name}”`}
                  description={`${plural(workspace.counts.tickets, "ticket")} and ${plural(workspace.counts.documents, "Document")}, ${
                    synced
                      ? `last synced ${workspace.last_synced_by ? `from ${workspace.last_synced_by} ` : ""}${synced}`
                      : "last sync not recorded"
                  }.`}
                >
                  {replaces && (
                    <span className="attachments-facts">{replaces}</span>
                  )}
                </ChoiceTile>
              );
            })}
            {/* Starting would land in the folder Reconnect names, minus the merge. */}
            {!options.reconnect && (
              <ChoiceTile
                value={START}
                title="Start a separate Workspace"
                description={`Your ${where} then holds two Workspaces, and they can't be merged later.`}
              />
            )}
          </ChoiceTiles>
        </SettingsSection>
      )}
      {options && startsAlone && (
        <SettingsSection
          title={`Your ${where} has no Workspace yet`}
          caption="Start with this one, and your other computers join it later."
        >
          {null}
        </SettingsSection>
      )}
      <div className="sync-footer">
        <SettingsList>
          <SettingsListFooter
            actions={
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      syncApi.disconnect,
                      `disconnect from ${storage.full}`,
                    )
                  }
                >
                  Back
                </Button>
                <Button
                  size="sm"
                  disabled={!options || busy}
                  onClick={() =>
                    download
                      ? setConfirming(true)
                      : void run(
                          choice === RECONNECT
                            ? syncApi.reconnect
                            : syncApi.uploadWorkspace,
                          "start sync",
                        )
                  }
                >
                  {download
                    ? "Join…"
                    : choice === RECONNECT
                      ? "Reconnect"
                      : "Start syncing"}
                </Button>
              </>
            }
          >
            {download
              ? "A safety copy of this computer's Workspace is saved first."
              : s3
                ? "ticketd does not encrypt the files it puts in the bucket."
                : "Files in your Drive are readable, not encrypted."}
          </SettingsListFooter>
        </SettingsList>
      </div>
      {busy && (
        <p role="status" className="sync-status-line">
          Starting sync…
        </p>
      )}
      <Failure
        {...(readFailure && {
          onRetry: () => {
            setReadFailure(null);
            setAttempt((count) => count + 1);
          },
        })}
        {...(s3 &&
          readFailure?.action === "choose_another" && {
            actions: (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setSwitching(true)}
              >
                Use another bucket…
              </Button>
            ),
          })}
      >
        {readFailure ?? failure}
      </Failure>
      {s3 ? (
        <DialogShell
          open={switching}
          onOpenChange={setSwitching}
          title="Use another bucket?"
          description="ticketd disconnects from this bucket so you can choose another bucket or profile. Nothing in the bucket or on this computer is deleted."
          primaryLabel="Use another bucket"
          blockedReason={null}
          size="sm"
          onSubmit={() => {
            setSwitching(false);
            void run(syncApi.disconnect, `disconnect from ${storage.full}`);
          }}
        >
          <dl className="sync-summary">
            <dt>On this computer</dt>
            <dd>This Workspace stays as it is</dd>
            <dt>In the bucket</dt>
            <dd>Your files stay, for your other computers</dd>
          </dl>
        </DialogShell>
      ) : (
        // One Google sign-in serves Files and sync, so the switch changes both.
        <UseAnotherAccountDialog
          open={switching}
          onOpenChange={setSwitching}
          account={status.account}
          sync="choosing"
          onConfirm={() => {
            setSwitching(false);
            void run(syncApi.useAnotherAccount, "use another account");
          }}
        />
      )}
      {options && download && (
        // Replacing local data is destructive, reviewed like a restore: the
        // consequence first, then what changes, the safety net in the note
        // slot, and a primary named for the result (set BK-10).
        <DialogShell
          open={confirming}
          onOpenChange={setConfirming}
          title="Replace this Workspace?"
          description={`Downloads “${download.folder_name}” from ${place}.`}
          primaryLabel="Replace Workspace"
          primaryVariant="destructive"
          footerNote="A safety backup is saved first."
          blockedReason={null}
          size="md"
          onSubmit={() => {
            setConfirming(false);
            void run(async () => {
              const replaced = await syncApi.downloadWorkspace(
                download.folder_id,
              );
              onDownloaded(replaced.safety_backup);
              void onReplaced();
              return replaced;
            }, "replace this Workspace");
          }}
        >
          <Alert tone="attention" role="note">
            <AlertTitle>
              This replaces everything in this Workspace on this computer
            </AlertTitle>
            <AlertDescription>
              The Workspace from {place} takes its place. What is here now is
              kept only in the safety backup.
            </AlertDescription>
          </Alert>
          <dl className="sync-summary">
            <dt>From {place}</dt>
            <dd>{contents(download.counts)}</dd>
            <dt>Replaced here</dt>
            <dd>{contents(options.local)}</dd>
            {!s3 && (
              <>
                <dt>Uploads</dt>
                <dd>Your Uploads folder is never touched</dd>
              </>
            )}
          </dl>
        </DialogShell>
      )}
    </>
  );
}

/** Step 4: the first upload or download, with its progress and no way back. */
export function FirstSync({
  status,
  progress,
}: {
  status: SyncStatus;
  progress: NonNullable<SyncStatus["first_sync"]>;
}) {
  const upload = progress.direction === "upload";
  const Icon = upload ? Upload : Download;
  const s3 = status.provider === "s3";
  // Where the files are, named with the Workspace's own folder.
  const where =
    status.folder && status.account
      ? `${upload ? "To" : "From"} “${status.folder.name}” in ${
          s3 && status.s3
            ? `bucket ${status.s3.bucket}`
            : `${status.account}’s Drive`
        }`
      : status.account;
  return (
    <div className="sync-block">
      <SettingsList>
        <SettingsRow
          leading={
            <SettingsRowTile>
              <Icon />
            </SettingsRowTile>
          }
          title={
            <span role="status">
              {progress.total
                ? `${upload ? "Uploading" : "Downloading"} ${progress.done} of ${progress.total} files`
                : "Preparing…"}
            </span>
          }
          description={where}
          // The 64px bar beside the words that count it (set SR-09). Until
          // the files are counted there is no share to show.
          trailing={
            progress.total ? (
              <Progress
                aria-label={upload ? "First upload" : "First download"}
                value={progress.done}
                max={Math.max(progress.total, 1)}
              />
            ) : null
          }
        />
        <SettingsListFooter>
          {upload
            ? "You can keep working. Everything is already saved on this computer."
            : "What was here before is kept as a restore point in Backups & export."}
        </SettingsListFooter>
      </SettingsList>
    </div>
  );
}
