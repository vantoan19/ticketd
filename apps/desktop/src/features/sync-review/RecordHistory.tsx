import { Fragment, useEffect, useState } from "react";
import { History } from "lucide-react";
import { DialogShell } from "@/components/ui/dialog-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
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

const CURRENT = "current";

type Loaded = { source: VersionSource; versions: Version[] };

function byDay(versions: Version[], now: Date) {
  const days: { day: string; versions: Version[] }[] = [];
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
 * one beside the current one on the right, Restore as the one action. This
 * desktop's own versions come first; a desktop that has none yet asks Google
 * Drive for the file's revisions.
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
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [fromDrive, setFromDrive] = useState(false);
  const [selected, setSelected] = useState(CURRENT);
  const [detail, setDetail] = useState<{
    version: string;
    fields: VersionDetail["fields"];
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const show = (source: VersionSource, versions: Version[]) => {
      setLoaded({ source, versions });
      setSelected(versions[0]?.id ?? CURRENT);
    };
    void (async () => {
      try {
        const local = await syncReview.versions({ kind, id, source: "local" });
        if (!active) return;
        if (local.length > 0) return show("local", local);
        setFromDrive(true);
      } catch (reason) {
        if (active) setError(String(reason));
        return;
      }
      // Drive is only a fallback: without sync it answers with nothing earlier.
      // When it cannot be asked, saying so beats claiming there are no versions.
      try {
        const drive = await syncReview.versions({ kind, id, source: "drive" });
        if (active) show("drive", drive);
      } catch (reason) {
        if (active)
          setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();
    return () => {
      active = false;
    };
  }, [kind, id]);
  const source = loaded?.source;
  useEffect(() => {
    if (!source || selected === CURRENT) return;
    let active = true;
    syncReview.version({ kind, id, source }, selected).then(
      ({ fields }) => {
        if (active) setDetail({ version: selected, fields });
      },
      (reason: unknown) => {
        if (active) setError(String(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [kind, id, source, selected]);
  async function restore() {
    if (!source) return;
    setBusy(true);
    setError("");
    try {
      await syncReview.restore({ kind, id, source }, selected);
      onRestored?.();
      onClose();
    } catch (reason) {
      setError(String(reason));
      setBusy(false);
    }
  }
  const now = new Date();
  const versions = loaded?.versions ?? [];
  const chosen = versions.find((version) => version.id === selected);
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
        source === "drive"
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
                    aria-current={selected === CURRENT || undefined}
                    onClick={() => setSelected(CURRENT)}
                  >
                    <span>Current version</span>
                    <small>This desktop</small>
                  </button>
                </li>
              </ul>
              {byDay(versions, now).map(({ day, versions: items }) => (
                <Fragment key={day}>
                  <h3>{day}</h3>
                  <ul>
                    {items.map((version) => (
                      <li key={version.id}>
                        <button
                          type="button"
                          className="sync-version"
                          aria-current={selected === version.id || undefined}
                          onClick={() => setSelected(version.id)}
                        >
                          <span>{formatTime(new Date(version.timestamp))}</span>
                          <small>
                            {[
                              version.device ?? "This desktop",
                              ...version.changed.map((field) =>
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
            </nav>
            <div className="sync-history-detail">
              {!chosen ? (
                <p>This is the {noun} as it is now.</p>
              ) : detail?.version !== chosen.id ? (
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
