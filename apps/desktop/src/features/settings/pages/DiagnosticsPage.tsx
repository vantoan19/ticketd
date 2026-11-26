import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, ExternalLink, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FailureAlert } from "@/components/ui/failure-alert";
import { Skeleton } from "@/components/ui/skeleton";
import { RevealButton } from "@/components/ui/reveal-button";
import { StatusLabel } from "@/components/ui/status-label";
import { Time } from "@/components/ui/time";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import {
  diagnosticsClient,
  type ErrorGroup,
  type LogLevel,
} from "@/lib/api/diagnostics";
import { workspaceClient } from "@/lib/api/workspace";
import { emptyCopy } from "@/lib/empty-copy";
import { plural, relativeDateTime } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { openBugReport } from "@/lib/issue-url";
import {
  sectionMeta,
  type SettingsSectionId as SectionId,
} from "@/features/settings/settings-sections";
import "@/features/settings/pages/about-page.css";
import { useSettingsState } from "@/features/settings/use-settings-state";
import { setDetailedLogging } from "@/features/settings/detailed-logging";
import { splitPath } from "@/features/settings/settings-format";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import {
  SettingsList,
  SettingsListFooter,
  SettingsRow,
} from "@/features/settings/layout/SettingsList";

/** How many kinds of error the page lists. */
const SHOWN_ERRORS = 5;

type Loaded<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "failed"; failure: FailureDescription };

const readLogLevel = () => diagnosticsClient.logLevel();
const readRecentErrors = () => diagnosticsClient.recentErrors();

/** A read that starts when the page opens and can be repeated. `read` must be stable. */
function useRead<T>(read: () => Promise<T>, what: string) {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });
  const run = useCallback(
    (): Promise<Loaded<T>> =>
      read().then(
        (value) => ({ status: "ready", value }),
        (reason: unknown) => ({
          status: "failed",
          failure: describeFailure(reason, what),
        }),
      ),
    [read, what],
  );
  useEffect(() => {
    let current = true;
    void run().then((next) => {
      if (current) setState(next);
    });
    return () => {
      current = false;
    };
  }, [run]);
  const reload = useCallback(async () => setState(await run()), [run]);
  return [state, setState, reload] as const;
}

/** What a saved report is called and where it is, for the row that follows a save. */
type Saved = { path: string; name: string };

/** One thing that failed, and what to repeat to try again. */
type Failed = {
  failure: FailureDescription;
  retry: (() => void) | null;
};

function ReportSection() {
  const [level, setLevel, reload] = useRead(readLogLevel, "read the log level");
  const [busy, setBusy] = useState<"start" | "cancel" | "save" | null>(null);
  const [failed, setFailed] = useState<Failed | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const choosing = useRef(false);
  const lastPath = useRef("");
  const current = level.status === "ready" ? level.value : null;
  const startedAt = current?.report_started_at ?? null;
  const overridden = current?.env_override != null;

  // The sidebar's status line says the same thing as this row.
  useEffect(() => {
    if (current) setDetailedLogging(current.report_started_at);
  }, [current]);

  async function change(
    action: "start" | "cancel",
    command: () => Promise<LogLevel>,
  ) {
    setFailed(null);
    setBusy(action);
    try {
      setLevel({ status: "ready", value: await command() });
      setSaved(null);
    } catch (reason) {
      setFailed({
        failure: describeFailure(
          reason,
          action === "start" ? "start detailed logging" : "cancel the report",
        ),
        retry: null,
      });
    } finally {
      setBusy(null);
    }
  }

  async function saveReport() {
    // One save sheet at a time; Saving… only once a path returns.
    if (choosing.current) return;
    choosing.current = true;
    setFailed(null);
    try {
      const path = await workspaceClient.chooseSavePath({
        title: "Save report",
        defaultPath:
          lastPath.current || (await diagnosticsClient.exportFileName()),
        filterName: "Zip archive",
        extension: "zip",
      });
      // Cancelling the sheet writes nothing and leaves the report open.
      if (path === null) return;
      lastPath.current = path;
      setBusy("save");
      try {
        const report = await diagnosticsClient.saveReport(path);
        setSaved({ path: report.path, name: splitPath(report.path).name });
        // Saving ends the report, so detailed logging is off again.
        await reloadQuietly();
      } catch (reason) {
        setFailed({
          failure: describeFailure(reason, "save the report"),
          retry: () => void saveReport(),
        });
      }
    } catch (reason) {
      setFailed({
        failure: describeFailure(reason, "open the save dialog"),
        retry: () => void saveReport(),
      });
    } finally {
      choosing.current = false;
      setBusy(null);
    }
  }

  async function reloadQuietly() {
    try {
      setLevel({ status: "ready", value: await readLogLevel() });
    } catch {
      // The report is saved; the page shows that, and the next read corrects the rest.
      setDetailedLogging(null);
    }
  }

  async function openFolder() {
    setFailed(null);
    try {
      await diagnosticsClient.openLogsFolder();
    } catch (reason) {
      setFailed({
        failure: describeFailure(reason, "open the logs folder"),
        retry: null,
      });
    }
  }

  async function openIssue() {
    setFailed(null);
    try {
      await openBugReport();
    } catch (reason) {
      setFailed({
        failure: describeFailure(reason, "open the issue form"),
        retry: () => void openIssue(),
      });
    }
  }

  const shown =
    failed ??
    (level.status === "failed"
      ? { failure: level.failure, retry: () => void reload() }
      : null);
  return (
    <SettingsSection title="Report a problem">
      <SettingsList>
        {saved ? (
          <SettingsRow
            title={<span role="status">Saved {saved.name}</span>}
            description="Attach it to your GitHub issue."
            trailing={
              <>
                <RevealButton
                  path={saved.path}
                  onFailure={(failure) =>
                    setFailed(failure && { failure, retry: null })
                  }
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void openIssue()}
                >
                  Open an issue
                  <ExternalLink aria-hidden="true" />
                </Button>
              </>
            }
          />
        ) : startedAt ? (
          <SettingsRow
            title={
              <StatusLabel tone="attention">Detailed logging is on</StatusLabel>
            }
            description={
              <>
                Repeat what went wrong, then save the report. Started{" "}
                <Time value={startedAt} />.
              </>
            }
            trailing={
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() =>
                    void change("cancel", diagnosticsClient.cancelReport)
                  }
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void saveReport()}
                >
                  {busy === "save" ? "Saving…" : "Save report…"}
                </Button>
              </>
            }
          />
        ) : (
          <SettingsRow
            title="Detailed logging"
            description={
              level.status === "loading" ? (
                <span className="flex h-4 items-center">
                  <Skeleton className="h-2 w-70" />
                </span>
              ) : overridden ? (
                <>
                  <code className="font-mono">
                    TICKETD_LOG={current?.env_override}
                  </code>{" "}
                  sets the level for this launch, so a report cannot turn it on.
                </>
              ) : (
                "Turn it on, repeat what went wrong, then save a report to attach to a GitHub issue."
              )
            }
            trailing={
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={current === null || overridden || busy !== null}
                onClick={() =>
                  void change("start", diagnosticsClient.startReport)
                }
              >
                Start
              </Button>
            }
          />
        )}
        <SettingsRow
          title="Log files"
          description="Kept for 7 days on this computer."
          trailing={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void openFolder()}
            >
              <FolderOpen aria-hidden="true" />
              Open logs folder
            </Button>
          }
        />
        <SettingsListFooter>
          {shown && (
            <FailureAlert
              size="compact"
              failure={shown.failure}
              className="mb-2"
              {...(shown.retry && { onRetry: shown.retry })}
            />
          )}
          Reports never hold the text of your tickets. Anyone can read files on
          a public GitHub issue.
        </SettingsListFooter>
      </SettingsList>
    </SettingsSection>
  );
}

/** A log message or error kind as a sentence: its first letter capitalised. */
function kindTitle(kind: string) {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/**
 * The Settings page a log target belongs to, by the start of its module path. The first match
 * wins; anything else is the app itself, which has no setting to open.
 */
const SETTINGS_OF: ReadonlyArray<readonly [prefix: string, page: SectionId]> = [
  ["ticketd_desktop_lib::sync", "workspace-sync"],
  ["ticketd_core::sync", "workspace-sync"],
  ["ticketd_desktop_lib::automation", "automations"],
  ["ticketd_automation_runner", "automations"],
  ["ticketd_core::automation", "automations"],
  ["ticketd_desktop_lib::chat", "agents"],
  ["ticketd_chat_host", "agents"],
  ["ticketd_core::chat", "agents"],
  ["ticketd_core::source", "ticket-sources"],
  ["ticketd_core::inbox", "attention"],
];

function settingOf(target: string): SectionId | null {
  return SETTINGS_OF.find(([prefix]) => target.startsWith(prefix))?.[1] ?? null;
}

/**
 * One kind of error: the error, then "Setting · count, last when". A row with a setting opens
 * its page from anywhere on it; an error of the app itself has none.
 */
function RecentError({
  title,
  setting,
  when,
  onOpen,
}: {
  title: string;
  setting: string;
  when: string;
  onOpen?: () => void;
}) {
  const text = (
    <span className="about-link-text">
      <span className="about-link-title">{title}</span>
      <span className="about-link-description">{`${setting} · ${when}`}</span>
    </span>
  );
  return (
    <div role="listitem">
      {onOpen ? (
        <button
          type="button"
          className="about-link-row"
          aria-label={`${title}. Open ${setting}`}
          onClick={onOpen}
        >
          {text}
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      ) : (
        <div className="about-link-row" data-static="">
          {text}
        </div>
      )}
    </div>
  );
}

function RecentErrorsSection() {
  const { openPage } = useSettingsState();
  const now = useNow();
  const [errors, , reload] = useRead<ErrorGroup[]>(
    readRecentErrors,
    "read the recent errors",
  );
  const empty = emptyCopy("diagnostics-errors");
  return (
    <SettingsSection
      title="Recent errors"
      caption="From the last 7 days of logs."
    >
      {errors.status === "failed" ? (
        <FailureAlert
          size="compact"
          failure={errors.failure}
          onRetry={() => void reload()}
        />
      ) : errors.status === "loading" ? (
        <SettingsList>
          <div role="status" aria-label="Reading recent errors">
            <SettingsRow>
              <Skeleton className="h-2.5 w-45" />
              <Skeleton className="mt-2 h-2 w-70" />
            </SettingsRow>
          </div>
        </SettingsList>
      ) : errors.value.length === 0 ? (
        <EmptyState
          size="inline"
          plain
          title={empty.title}
          description={empty.sentence}
        />
      ) : (
        <SettingsList role="list" aria-label="Recent errors">
          {errors.value.slice(0, SHOWN_ERRORS).map((group) => {
            const page = settingOf(group.target);
            const when = `${plural(group.count, "time")}, last ${relativeDateTime(group.last_seen, now)}`;
            return (
              <RecentError
                key={`${group.target}:${group.kind}`}
                title={kindTitle(group.kind)}
                setting={page ? sectionMeta(page).label : "App"}
                when={when}
                {...(page && { onOpen: () => openPage(page) })}
              />
            );
          })}
        </SettingsList>
      )}
    </SettingsSection>
  );
}

export function DiagnosticsPage() {
  return (
    <SettingsPage {...sectionMeta("diagnostics")}>
      <ReportSection />
      <RecentErrorsSection />
    </SettingsPage>
  );
}
