import { useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FailureAlert } from "@/components/ui/failure-alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Time } from "@/components/ui/time";
import { useCopy } from "@/components/ui/use-copy";
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
import { plural } from "@/lib/format";
import { fileManagerName } from "@/lib/platform";
import { sectionMeta } from "@/features/settings/settings-sections";
import { lineFailure, splitPath } from "@/features/settings/settings-format";
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

function LogsSection() {
  const [level, setLevel, reload] = useRead(readLogLevel, "read the log level");
  const [pending, setPending] = useState<boolean | null>(null);
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  async function changeDebug(enabled: boolean) {
    setFailure(null);
    setPending(enabled);
    try {
      const next: LogLevel = await diagnosticsClient.setDebug(enabled);
      setLevel({ status: "ready", value: next });
    } catch (reason) {
      setFailure(describeFailure(reason, "change the log level"));
    } finally {
      setPending(null);
    }
  }
  async function openFolder() {
    setFailure(null);
    try {
      await diagnosticsClient.openLogsFolder();
    } catch (reason) {
      setFailure(describeFailure(reason, "open the logs folder"));
    }
  }
  const current = level.status === "ready" ? level.value : null;
  const overridden = current?.env_override != null;
  const shown = failure ?? (level.status === "failed" ? level.failure : null);
  return (
    <SettingsSection title="Logs">
      <SettingsList>
        <SettingsRow
          variant="top"
          title="Debug logging"
          titleId="debug-logging-label"
          descriptionId="debug-logging-description"
          description={
            level.status === "loading" ? (
              <span className="flex h-4 items-center">
                <Skeleton className="h-2 w-70" />
              </span>
            ) : level.status === "failed" ? (
              "The log level could not be read."
            ) : overridden ? (
              <>
                <code className="font-mono">
                  TICKETD_LOG={current?.env_override}
                </code>{" "}
                sets the level for this launch, so this switch has no effect.
              </>
            ) : (
              `Level: ${current?.level}. Records more detail until ticketd restarts.`
            )
          }
          trailing={
            <Switch
              aria-labelledby="debug-logging-label"
              aria-describedby="debug-logging-description"
              checked={pending ?? current?.debug ?? false}
              disabled={current === null || overridden || pending !== null}
              onCheckedChange={(enabled) => void changeDebug(enabled)}
            />
          }
        />
        <SettingsRow
          title="Log files"
          description="One file per day, kept for 7 days. They stay on this computer."
          trailing={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void openFolder()}
            >
              <FolderOpen aria-hidden="true" />
              Open logs folder
            </Button>
          }
        />
        {shown && (
          <SettingsListFooter>
            <FailureAlert
              size="compact"
              failure={shown}
              {...(!failure && { onRetry: () => void reload() })}
            />
          </SettingsListFooter>
        )}
      </SettingsList>
    </SettingsSection>
  );
}

function ReportSection() {
  const [exporting, setExporting] = useState(false);
  const [copying, setCopying] = useState(false);
  const [failed, setFailed] = useState<{
    action: "export" | "summary";
    failure: FailureDescription;
  } | null>(null);
  const [savedName, setSavedName] = useState("");
  const choosing = useRef(false);
  const lastPath = useRef("");
  const { copied, error, copy } = useCopy();

  async function exportDiagnostics() {
    // One save sheet at a time; Exporting… only once a path returns.
    if (choosing.current) return;
    choosing.current = true;
    setFailed(null);
    setSavedName("");
    try {
      const path = await workspaceClient.chooseSavePath({
        title: "Export diagnostics",
        defaultPath:
          lastPath.current || (await diagnosticsClient.exportFileName()),
        filterName: "Zip archive",
        extension: "zip",
      });
      if (path === null) return;
      lastPath.current = path;
      setExporting(true);
      try {
        const exported = await diagnosticsClient.export(path);
        setSavedName(splitPath(exported.path).name);
      } catch (reason) {
        setFailed({
          action: "export",
          failure: describeFailure(reason, "export the diagnostics"),
        });
      }
    } catch (reason) {
      setFailed({
        action: "export",
        failure: describeFailure(reason, "open the save dialog"),
      });
    } finally {
      choosing.current = false;
      setExporting(false);
    }
  }

  async function copySummary() {
    setFailed(null);
    setCopying(true);
    try {
      await copy("summary", await diagnosticsClient.summary());
    } catch (reason) {
      setFailed({
        action: "summary",
        failure: describeFailure(reason, "read the summary"),
      });
    } finally {
      setCopying(false);
    }
  }

  const shown = failed?.failure ?? (error ? lineFailure(error) : null);
  return (
    <SettingsSection title="Report a problem">
      <SettingsList>
        <SettingsRow
          title="Export diagnostics"
          description={
            savedName ? (
              <span role="status">
                Saved {savedName} and showed it in {fileManagerName()}.
              </span>
            ) : (
              "A small .zip of redacted logs and Workspace health to attach to a bug report."
            )
          }
          trailing={
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={exporting}
              onClick={() => void exportDiagnostics()}
            >
              {exporting ? "Exporting…" : "Export diagnostics…"}
            </Button>
          }
        />
        <SettingsRow
          title="Summary"
          description="The version and system details an issue form asks for."
          trailing={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-w-28"
              disabled={copying}
              onClick={() => void copySummary()}
            >
              {copying ? "Copying…" : copied ? "Copied" : "Copy summary"}
            </Button>
          }
        />
        <SettingsListFooter>
          {shown && (
            <FailureAlert
              size="compact"
              failure={shown}
              className="mb-2"
              {...(failed && {
                onRetry: () =>
                  void (failed.action === "export"
                    ? exportDiagnostics()
                    : copySummary()),
              })}
            />
          )}
          Files attached to a public GitHub issue can be read by anyone.
        </SettingsListFooter>
      </SettingsList>
    </SettingsSection>
  );
}

/** A log message or error kind as a sentence: its first letter capitalised. */
function kindTitle(kind: string) {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** The last segment of a module path: `ticketd_desktop_lib::sync_scheduler` is `sync_scheduler`. */
function shortTarget(target: string) {
  return target.split("::").pop() || target;
}

function RecentErrorsSection() {
  const [errors, , reload] = useRead<ErrorGroup[]>(
    readRecentErrors,
    "read the recent errors",
  );
  const empty = emptyCopy("diagnostics-errors");
  return (
    <SettingsSection
      title="Recent errors"
      caption="The last kinds of warning and error ticketd logged, from the files still kept."
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
          {errors.value.slice(0, SHOWN_ERRORS).map((group) => (
            <SettingsRow
              key={`${group.target}:${group.kind}`}
              role="listitem"
              title={kindTitle(group.kind)}
              description={`${group.level === "ERROR" ? "Error" : "Warning"} in ${shortTarget(group.target)}`}
              trailing={
                <span className="text-xs leading-4 whitespace-nowrap text-muted-foreground tabular-nums">
                  {plural(group.count, "time")}, last{" "}
                  <Time value={group.last_seen} />
                </span>
              }
            />
          ))}
        </SettingsList>
      )}
    </SettingsSection>
  );
}

export function DiagnosticsPage() {
  return (
    <SettingsPage
      {...sectionMeta("diagnostics")}
      lede="Logs for finding out what went wrong. They stay on this computer unless you attach an export to an issue."
    >
      <LogsSection />
      <ReportSection />
      <RecentErrorsSection />
    </SettingsPage>
  );
}
