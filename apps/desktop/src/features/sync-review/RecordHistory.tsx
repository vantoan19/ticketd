import { useDialogPresence } from "@/components/ui/use-dialog-presence";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { storageName } from "@/features/sync/storage-name";
import { useSyncStatus } from "@/features/sync/sync-status";
import { formatTime } from "@/lib/format";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { FailureState } from "@/components/ui/failure-alert";
import {
  syncReview,
  type Version,
  type VersionDetail,
  type VersionedKind,
  type VersionSource,
} from "@/lib/sync-review-api";
import { FieldValue } from "./FieldValue";
import { dayLabel, dayTime, fieldLabel } from "./labels";
import { useRequestIds } from "./use-request-ids";
import "./sync-review.css";

/** A version and where it is kept; the two sources name versions separately. */
type Entry = Version & { source: VersionSource };
type Chosen = Pick<Entry, "source" | "id">;

const from = (source: VersionSource, versions: Version[]): Entry[] =>
  versions.map((version) => ({ ...version, source }));
const same = (a: Chosen | null, b: Chosen | null) =>
  a?.source === b?.source && a?.id === b?.id;

/**
 * Where a version came from, then the fields in which it differs from the
 * current one: what selecting it shows. The storage does not say which desktop
 * wrote a version, and nothing records where the oldest kept version came from.
 */
function versionLabel(
  kind: VersionedKind,
  entry: Entry,
  storage: string,
): string {
  const remote = entry.source !== "local";
  const fields = entry.changed.map((field) => fieldLabel(kind, field));
  return [
    remote
      ? storage
      : entry.oldest
        ? "Earliest version kept"
        : (entry.device ?? "This desktop"),
    // The storage's versions are not read for the list, so theirs are not known.
    ...(fields.length || remote ? fields : ["Same as now"]),
  ].join(" · ");
}

function byDay(versions: Entry[], now: Date) {
  const days: { day: string; versions: Entry[] }[] = [];
  for (const version of versions) {
    const day = dayLabel(version.timestamp, now);
    const last = days[days.length - 1];
    if (last?.day === day) last.versions.push(version);
    else days.push({ day, versions: [version] });
  }
  return days;
}

/**
 * History of a ticket or Document: earlier versions on the left, the selected
 * one beside the current one on the right, Restore as the one action, newest
 * first. The storage's versions of the file (Google Drive revisions, S3 object
 * versions) are read when asked for, or at once on a desktop that has no
 * versions yet, and listed among this desktop's own by time.
 */
export function RecordHistory({
  kind,
  id,
  subtitle,
  onClose,
  onRestored,
}: {
  kind: VersionedKind;
  id: string;
  /** The record the History is of, such as "T-KQ12 · Fix login". */
  subtitle: string;
  onClose: () => void;
  onRestored?: () => void;
}) {
  const presence = useDialogPresence(onClose);
  const { status } = useSyncStatus();
  const connected = status?.connection === "connected";
  const storage = storageName(status?.provider);
  /** Where the older versions are read from, named after the Workspace's storage. */
  const remote: VersionSource = status?.provider === "s3" ? "s3" : "drive";
  const [local, setLocal] = useState<Entry[] | null>(null);
  /** `null` until the storage was asked and answered. */
  const [older, setOlder] = useState<Entry[] | null>(null);
  const [asking, setAsking] = useState(false);
  const [selected, setSelected] = useState<Chosen | null>(null);
  const [detail, setDetail] = useState<{
    version: Chosen;
    fields: VersionDetail["fields"];
  } | null>(null);
  const [error, setError] = useState<{
    failure: FailureDescription;
    retry: () => void;
  } | null>(null);
  const [readAttempt, setReadAttempt] = useState(0);
  const reload = useCallback(() => {
    setError(null);
    setReadAttempt((attempt) => attempt + 1);
  }, []);
  const [busy, setBusy] = useState(false);
  // Set at once, where `busy` waits for a render: a second submit finds it.
  const restoring = useRef(false);
  const requestId = useRequestIds();
  useEffect(() => {
    let active = true;
    void (async () => {
      let found: Entry[];
      try {
        found = from(
          "local",
          await syncReview.versions({ kind, id, source: "local" }),
        );
      } catch (reason) {
        if (active)
          setError({
            failure: describeFailure(reason, "load versions"),
            retry: reload,
          });
        return;
      }
      if (!active) return;
      setLocal(found);
      setSelected(found[0] ?? null);
      if (found.length > 0) return;
      // Nothing kept here yet: the storage is asked without waiting to be. Without
      // sync it answers with nothing earlier. When it cannot be asked, saying
      // so beats claiming there are no versions.
      try {
        const found = from(
          remote,
          await syncReview.versions({ kind, id, source: remote }),
        );
        if (!active) return;
        setOlder(found);
        setSelected(found[0] ?? null);
      } catch (reason) {
        if (active)
          setError({
            failure: describeFailure(reason, "load versions"),
            retry: reload,
          });
      }
    })();
    return () => {
      active = false;
    };
  }, [kind, id, remote, readAttempt, reload]);
  async function askOlder() {
    setAsking(true);
    setError(null);
    try {
      setOlder(
        from(remote, await syncReview.versions({ kind, id, source: remote })),
      );
    } catch (reason) {
      setError({
        failure: describeFailure(reason, "load older versions"),
        retry: () => void askOlder(),
      });
    }
    setAsking(false);
  }
  const source = selected?.source;
  const version = selected?.id;
  useEffect(() => {
    if (!source || version === undefined) return;
    let active = true;
    syncReview.version({ kind, id, source }, version).then(
      ({ fields }) => {
        if (active) setDetail({ version: { source, id: version }, fields });
      },
      (reason: unknown) => {
        if (active)
          setError({
            failure: describeFailure(reason, "load this version"),
            retry: reload,
          });
      },
    );
    return () => {
      active = false;
    };
  }, [kind, id, source, version, readAttempt, reload]);
  async function restore() {
    if (!selected || restoring.current) return;
    restoring.current = true;
    setBusy(true);
    setError(null);
    try {
      await syncReview.restore(
        { kind, id, source: selected.source },
        selected.id,
        requestId([selected.source, selected.id]),
      );
      onRestored?.();
      presence.close();
    } catch (reason) {
      setError({
        failure: describeFailure(reason, "restore this version"),
        retry: () => void restore(),
      });
      restoring.current = false;
      setBusy(false);
    }
  }
  const now = new Date();
  // Shown once this desktop answered and, where it keeps nothing, the storage did too.
  const loaded = local !== null && (local.length > 0 || older !== null);
  const fromStorage = local !== null && !loaded;
  // The two sources overlap in time, and a day gets one heading.
  const versions = [...(local ?? []), ...(older ?? [])].sort(
    (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp),
  );
  const chosen = versions.find((entry) => same(entry, selected));
  const noun = kind === "ticket" ? "ticket" : "Document";
  const blockedReason = !loaded
    ? error
      ? ""
      : fromStorage
        ? `Loading versions from ${storage.full}…`
        : "Loading versions…"
    : versions.length === 0
      ? "Nothing to restore yet"
      : !chosen
        ? "Choose an earlier version to restore"
        : null;
  return (
    <DialogShell
      {...presence.dialog}
      title="History"
      description={subtitle}
      primaryLabel="Restore"
      cancelLabel="Close"
      blockedReason={blockedReason}
      footerNote={
        (chosen ?? versions[0])?.source !== "local"
          ? `From ${storage.full}. Restoring adds a new version; nothing is lost.`
          : "Kept for 30 days. Restoring adds a new version; nothing is lost."
      }
      onSubmit={() => void restore()}
      size="lg"
      busy={busy}
    >
      <div className="sync-history-feedback">
        {error && (
          <FailureState
            failure={error.failure}
            onRetry={error.retry}
            size="inline"
            detailsVariant="popover"
          />
        )}
      </div>
      <div className="sync-history">
        {!loaded ? (
          !error && (
            <>
              <div
                className="sync-history-list"
                role="status"
                aria-label={
                  fromStorage
                    ? `Loading versions from ${storage.full}`
                    : "Loading versions"
                }
              >
                <div className="sync-skeleton-list">
                  {[0, 1, 2, 3].map((row) => (
                    <div key={row}>
                      <Skeleton className="h-4 w-24" />
                      <Skeleton className="h-3 w-40" />
                    </div>
                  ))}
                </div>
              </div>
              <div className="sync-history-detail" />
            </>
          )
        ) : versions.length === 0 ? (
          <div className="sync-history-empty">
            <EmptyState
              icon={<History />}
              title="No earlier versions"
              description={`A version is kept each time this ${noun} changes, for 30 days.`}
            />
          </div>
        ) : (
          <>
            <nav className="sync-history-list" aria-label="Versions">
              <ul>
                <li>
                  <button
                    type="button"
                    className="sync-version"
                    aria-current={selected === null || undefined}
                    onClick={() => setSelected(null)}
                  >
                    <span>Current version</span>
                    <small>On this desktop now</small>
                  </button>
                </li>
              </ul>
              {byDay(versions, now).map(({ day, versions: items }) => (
                <Fragment key={`${items[0]?.source}:${items[0]?.id}`}>
                  <h3>{day}</h3>
                  <ul>
                    {items.map((entry) => (
                      <li key={`${entry.source}:${entry.id}`}>
                        <button
                          type="button"
                          className="sync-version"
                          aria-current={same(entry, selected) || undefined}
                          onClick={() =>
                            setSelected({ source: entry.source, id: entry.id })
                          }
                        >
                          <span>{formatTime(new Date(entry.timestamp))}</span>
                          <small>
                            {versionLabel(kind, entry, storage.full)}
                          </small>
                        </button>
                      </li>
                    ))}
                  </ul>
                </Fragment>
              ))}
              {older === null && connected && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={asking}
                  onClick={() => void askOlder()}
                >
                  {asking
                    ? `Loading from ${storage.full}…`
                    : `Older versions from ${storage.short}`}
                </Button>
              )}
              {older?.length === 0 && (
                <p role="status">No older versions in {storage.full}</p>
              )}
            </nav>
            <div className="sync-history-detail">
              {!chosen ? (
                <p>This is the {noun} as it is now.</p>
              ) : !detail || !same(detail.version, chosen) ? (
                <p role="status">Loading this version…</p>
              ) : detail.fields.length === 0 ? (
                <p>This version is the same as the current one.</p>
              ) : (
                <div className="sync-changes">
                  <span />
                  <span className="sync-col">
                    {dayTime(chosen.timestamp, now)}
                  </span>
                  <span className="sync-col">Current version</span>
                  {detail.fields.map(({ field, value, current }) => (
                    <Fragment key={field}>
                      <span className="sync-key">
                        {fieldLabel(kind, field)}
                      </span>
                      <div className="sync-pane">
                        <FieldValue
                          field={field}
                          value={value}
                          against={current}
                          mark="del"
                        />
                      </div>
                      <div className="sync-pane">
                        <FieldValue
                          field={field}
                          value={current}
                          against={value}
                        />
                      </div>
                    </Fragment>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </DialogShell>
  );
}
