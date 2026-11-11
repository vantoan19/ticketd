import { Fragment, useEffect, useState } from "react";
import { History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useSyncStatus } from "@/features/sync/sync-status";
import { formatTime } from "@/lib/format";
import {
  syncReview,
  type Version,
  type VersionDetail,
  type VersionedKind,
  type VersionSource,
} from "@/lib/sync-review-api";
import { FieldValue } from "./FieldValue";
import { dayLabel, dayTime, fieldLabel } from "./labels";
import "./sync-review.css";

/** A version and where it is kept; the two sources name versions separately. */
type Entry = Version & { source: VersionSource };
type Chosen = Pick<Entry, "source" | "id">;

const from = (source: VersionSource, versions: Version[]): Entry[] =>
  versions.map((version) => ({ ...version, source }));
const same = (a: Chosen | null, b: Chosen | null) =>
  a?.source === b?.source && a?.id === b?.id;

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
 * first. Google Drive's revisions of the file are read when asked for, or at
 * once on a desktop that has no versions yet, and listed among this desktop's
 * own by time.
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
  const connected = useSyncStatus().status?.connection === "connected";
  const [local, setLocal] = useState<Entry[] | null>(null);
  /** `null` until Drive was asked and answered. */
  const [drive, setDrive] = useState<Entry[] | null>(null);
  const [asking, setAsking] = useState(false);
  const [selected, setSelected] = useState<Chosen | null>(null);
  const [detail, setDetail] = useState<{
    version: Chosen;
    fields: VersionDetail["fields"];
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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
        if (active) setError(String(reason));
        return;
      }
      if (!active) return;
      setLocal(found);
      setSelected(found[0] ?? null);
      if (found.length > 0) return;
      // Nothing kept here yet: Drive is asked without waiting to be. Without
      // sync it answers with nothing earlier. When it cannot be asked, saying
      // so beats claiming there are no versions.
      try {
        const older = from(
          "drive",
          await syncReview.versions({ kind, id, source: "drive" }),
        );
        if (!active) return;
        setDrive(older);
        setSelected(older[0] ?? null);
      } catch (reason) {
        if (active)
          setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();
    return () => {
      active = false;
    };
  }, [kind, id]);
  async function older() {
    setAsking(true);
    setError("");
    try {
      setDrive(
        from("drive", await syncReview.versions({ kind, id, source: "drive" })),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
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
        if (active) setError(String(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [kind, id, source, version]);
  async function restore() {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      await syncReview.restore(
        { kind, id, source: selected.source },
        selected.id,
      );
      onRestored?.();
      onClose();
    } catch (reason) {
      setError(String(reason));
      setBusy(false);
    }
  }
  const now = new Date();
  // Shown once this desktop answered and, where it keeps nothing, Drive did too.
  const loaded = local !== null && (local.length > 0 || drive !== null);
  const fromDrive = local !== null && !loaded;
  // The two sources overlap in time, and a day gets one heading.
  const versions = [...(local ?? []), ...(drive ?? [])].sort(
    (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp),
  );
  const chosen = versions.find((entry) => same(entry, selected));
  const noun = kind === "ticket" ? "ticket" : "Document";
  const blockedReason = !loaded
    ? error
      ? ""
      : fromDrive
        ? "Loading versions from Google Drive…"
        : "Loading versions…"
    : versions.length === 0
      ? "Nothing to restore yet"
      : !chosen
        ? "Choose an earlier version to restore"
        : null;
  return (
    <DialogShell
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="History"
      description={subtitle}
      primaryLabel="Restore"
      cancelLabel="Close"
      blockedReason={blockedReason}
      footerNote={
        (chosen ?? versions[0])?.source === "drive"
          ? "From Google Drive. Restoring adds a new version; nothing is lost."
          : "Kept for 30 days. Restoring adds a new version; nothing is lost."
      }
      onSubmit={() => void restore()}
      width={920}
      busy={busy}
    >
      {error && <p role="alert">{error}</p>}
      <div className="sync-history">
        {!loaded ? (
          !error && (
            <>
              <div
                className="sync-history-list"
                role="status"
                aria-label={
                  fromDrive
                    ? "Loading versions from Google Drive"
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
                    <small>This desktop</small>
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
                            {[
                              // Drive does not say which desktop wrote a revision.
                              entry.source === "drive"
                                ? "Google Drive"
                                : (entry.device ?? "This desktop"),
                              ...entry.changed.map((field) =>
                                fieldLabel(kind, field),
                              ),
                            ].join(" · ")}
                          </small>
                        </button>
                      </li>
                    ))}
                  </ul>
                </Fragment>
              ))}
              {drive === null && connected && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={asking}
                  onClick={() => void older()}
                >
                  {asking
                    ? "Loading from Google Drive…"
                    : "Older versions from Drive"}
                </Button>
              )}
              {drive?.length === 0 && (
                <p role="status">No older versions in Google Drive</p>
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
