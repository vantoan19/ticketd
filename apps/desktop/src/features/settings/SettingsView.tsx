import type { SettingsCardKey } from "./settings-sections";
import { AttachmentSettings } from "./AttachmentSettings";
import { useEffect, useRef, useState, type RefObject } from "react";
import {
  Copy,
  ExternalLink,
  FolderOpen,
  Loader2,
  Monitor,
  Moon,
  Sun,
  ChevronDown,
} from "lucide-react";
import { RadioGroup } from "radix-ui";
import { client } from "@/lib/api/client";
import {
  workspaceClient,
  type BackupRecord,
  type WorkspaceInfo,
} from "@/lib/api/workspace";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { PathText } from "@/features/projects/PathText";
import { APP_VERSION } from "@/lib/app-version";
import {
  setPreference,
  usePreferences,
  type OpenTicketsPreference,
} from "@/lib/preferences";
import { StatusDot } from "@/components/ui/status-dot";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Kbd } from "@/components/ui/kbd";
import { modifierKeyLabel, fileManagerName } from "@/lib/platform";
import { formatDateTime } from "@/lib/format";
import { writeClipboard } from "@/lib/clipboard";
import { CommandText } from "@/features/settings/CommandText";
import { revealFile } from "@/lib/reveal";
import { SettingsCard } from "@/features/settings/SettingsCard";
import { AttentionCard } from "@/features/settings/AttentionCard";
import { AgentSkillsCard } from "@/features/settings/AgentSkillsCard";
import { CommandLineCard } from "@/features/settings/CommandLineCard";
import { RestoreDialog } from "@/features/settings/RestoreDialog";
import { SafetyBackups } from "@/features/settings/SafetyBackups";
import { SourceCard } from "@/features/settings/sources/SourceCard";
import { useSources } from "@/features/settings/sources/use-sources";
import type { SourceEntry } from "@/lib/api/sources";
import "@/features/settings/sources/sources.css";
import "@/features/settings/settings.css";

const THEME_OPTIONS = [
  { value: "system", label: "System", icon: <Monitor aria-hidden="true" /> },
  { value: "light", label: "Light", icon: <Sun aria-hidden="true" /> },
  { value: "dark", label: "Dark", icon: <Moon aria-hidden="true" /> },
] as const;

function LayoutPreview({ kind }: { kind: OpenTicketsPreference }) {
  return (
    <span
      className="layout-preview"
      data-layout={kind}
      aria-hidden="true"
      role="presentation"
    >
      {kind === "split" ? (
        <>
          <span className="layout-preview-list" />
          <span className="layout-preview-detail" />
        </>
      ) : (
        <span className="layout-preview-detail" />
      )}
    </span>
  );
}

const OPEN_TICKETS_OPTIONS: {
  value: OpenTicketsPreference;
  label: string;
  hint: string;
}[] = [
  { value: "split", label: "Beside the list", hint: "Split view" },
  { value: "expanded", label: "Full width", hint: "Expanded view" },
];

function AppearanceCard() {
  const { theme, openTickets } = usePreferences();
  const [failure, setFailure] = useState("");
  const report = (saved: boolean, what: string) =>
    setFailure(saved ? "" : `Could not save ${what}.`);
  return (
    <SettingsCard id="appearance" title="Appearance">
      <div className="settings-row">
        <div>
          <p className="settings-label" id="theme-label">
            Theme
          </p>
          <p className="settings-hint">
            System follows your operating system. Light and Dark override it.
          </p>
        </div>
        <SegmentedControl
          aria-labelledby="theme-label"
          value={theme}
          onValueChange={(value) =>
            report(setPreference("theme", value), "the theme")
          }
          options={[...THEME_OPTIONS]}
        />
      </div>
      <div className="settings-row settings-row-stacked">
        <div>
          <p className="settings-label" id="open-tickets-label">
            Open tickets
          </p>
          <p className="settings-hint">
            Applies to the next ticket you open from a list.
          </p>
        </div>
        <RadioGroup.Root
          aria-labelledby="open-tickets-label"
          value={openTickets}
          onValueChange={(value) =>
            report(
              setPreference("openTickets", value as OpenTicketsPreference),
              "the Open tickets choice",
            )
          }
          orientation="horizontal"
          className="layout-choices"
        >
          {OPEN_TICKETS_OPTIONS.map((option) => (
            <RadioGroup.Item
              key={option.value}
              value={option.value}
              className="layout-choice"
            >
              <LayoutPreview kind={option.value} />
              <span className="layout-choice-label">
                <span className="layout-choice-dot" aria-hidden="true" />
                {option.label}
              </span>
              <span className="settings-hint">{option.hint}</span>
            </RadioGroup.Item>
          ))}
        </RadioGroup.Root>
      </div>
      {failure && (
        <p role="alert" className="settings-failure">
          {failure}
        </p>
      )}
    </SettingsCard>
  );
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function LocationCard({ refreshKey }: { refreshKey: number }) {
  const [info, setInfo] = useState<WorkspaceInfo | null>(null);
  const [loadFailure, setLoadFailure] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    let current = true;
    workspaceClient
      .info()
      .then((value) => {
        if (current) setInfo(value);
      })
      .catch((reason: unknown) => {
        if (current)
          setLoadFailure(`Could not read the workspace: ${String(reason)}`);
      });
    return () => {
      current = false;
    };
  }, [refreshKey]);
  async function copyPath(path: string) {
    const failure = await writeClipboard(path);
    setMessage(
      failure === null ? "Path copied." : `Could not copy the path: ${failure}`,
    );
  }
  async function reveal(path: string) {
    setMessage((await revealFile(path)) ?? "");
  }
  const manager = fileManagerName();
  const facts = info && [
    ["Tickets", String(info.tickets)],
    ["Documents", String(info.documents)],
    ["Projects", String(info.projects)],
    ["Active Plans", String(info.active_plans)],
    ["File size", formatSize(info.size_bytes)],
    ["Format version", String(info.format_version)],
  ];
  return (
    <SettingsCard
      id="location"
      title="Location"
      description="The desktop app and the ticketd command line read and write this workspace."
    >
      {loadFailure && (
        <p role="alert" className="settings-failure">
          {loadFailure}
        </p>
      )}
      {info && facts && (
        <>
          <div className="workspace-location">
            <p className="workspace-path" aria-label="Workspace path">
              <PathText path={info.path} />
            </p>
            <IconButton
              type="button"
              label="Copy path"
              onClick={() => void copyPath(info.path)}
            >
              <Copy aria-hidden="true" />
            </IconButton>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void reveal(info.path)}
            >
              <FolderOpen aria-hidden="true" />
              Show in {manager}
            </Button>
          </div>
          <dl className="workspace-facts">
            {facts.map(([name, value]) => (
              <div key={name} className="workspace-fact">
                <dt>{name}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      <p role="status" className="settings-hint">
        {message}
      </p>
    </SettingsCard>
  );
}

/** Today's date as YYYY-MM-DD in local time, for suggested file names. */
function localDate() {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function BackupsCard({ onRestore }: { onRestore: () => Promise<void> }) {
  const [last, setLast] = useState<BackupRecord | null>(null);
  const [failure, setFailure] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [showSafety, setShowSafety] = useState(false);
  const [restoredCount, setRestoredCount] = useState(0);
  const [safetyCount, setSafetyCount] = useState(0);
  useEffect(() => {
    let current = true;
    void Promise.resolve(workspaceClient.safetyBackups())
      .then((value) => {
        if (current && Array.isArray(value)) setSafetyCount(value.length);
      })
      .catch(() => {
        // The count is informational; the list reports its own failure.
      });
    return () => {
      current = false;
    };
  }, [restoredCount]);
  useEffect(() => {
    let current = true;
    workspaceClient
      .lastBackup()
      .then((value) => {
        if (current) setLast(value);
      })
      .catch(() => {
        // The status is informational; backing up still works without it.
      });
    return () => {
      current = false;
    };
  }, []);
  async function backUp() {
    setBusy(true);
    setFailure("");
    setMessage("");
    try {
      const path = await workspaceClient.chooseSavePath({
        title: "Back up ticketd workspace",
        defaultPath: `ticketd-backup-${localDate()}.sqlite3`,
        filterName: "ticketd backup",
        extension: "sqlite3",
      });
      if (path === null) return;
      let recorded: boolean;
      try {
        recorded = await client.backupWorkspace(path);
      } catch (reason) {
        // The core says what happened, such as an existing file at the path.
        setFailure(`The backup was not saved: ${String(reason)}`);
        return;
      }
      setMessage(
        recorded
          ? "Backup saved and checked."
          : "Backup saved and checked, but the Last backup status could not be updated.",
      );
      try {
        setLast(await workspaceClient.lastBackup());
      } catch {
        // Keep the previous status; the backup itself succeeded.
      }
    } catch (reason) {
      setFailure(`Could not open the save dialog: ${String(reason)}`);
    } finally {
      setBusy(false);
    }
  }
  async function reveal(path: string) {
    const failure = await revealFile(path);
    if (failure) setFailure(failure);
  }
  async function chooseBackup() {
    setFailure("");
    try {
      const path = await workspaceClient.chooseBackupFile({
        title: "Choose a ticketd backup",
      });
      if (path !== null) setRestoring(path);
    } catch (reason) {
      setFailure(`Could not open the file dialog: ${String(reason)}`);
    }
  }
  return (
    <SettingsCard
      id="backups"
      title="Backups"
      description="A complete copy of the workspace and every retained local attachment file, checked for integrity after it is saved. Remote files remain references and metadata. It never replaces an existing file."
      actions={
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void backUp()}
        >
          {busy ? (
            <>
              <Loader2 aria-hidden="true" className="animate-spin" />
              Backing up…
            </>
          ) : (
            "Back up now…"
          )}
        </Button>
      }
    >
      <div className="backup-status" role="group" aria-label="Last backup">
        {last ? (
          <>
            <p className="settings-label">
              Last backup{" "}
              <span className="settings-hint">
                {formatDateTime(last.completed_at)}
              </span>
            </p>
            <p className="workspace-path" aria-label="Last backup path">
              {last.path}
            </p>
            <div className="settings-actions">
              <span className="status-word">
                <StatusDot tone="checked" />
                Checked
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void reveal(last.path)}
              >
                <FolderOpen aria-hidden="true" />
                Show in {fileManagerName()}
              </Button>
            </div>
          </>
        ) : (
          <p className="settings-hint">
            No backups yet. Your first one will be listed here with its date and
            size.
          </p>
        )}
      </div>
      {failure && (
        <p role="alert" className="settings-failure">
          {failure}
        </p>
      )}
      <p role="status" className="settings-hint">
        {message}
      </p>
      <div className="backup-restore-row">
        <div>
          <p className="settings-label">Restore from a backup</p>
          <p className="settings-hint">
            You review what the backup contains before anything changes.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void chooseBackup()}
        >
          Restore from backup…
        </Button>
      </div>
      <div className="backup-footer">
        <div className="backup-footer-row">
          <p className="settings-hint">
            Restoring saves a safety backup of the current workspace first.
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="safety-toggle"
            aria-expanded={showSafety}
            onClick={() => setShowSafety((shown) => !shown)}
          >
            Safety backups · {safetyCount}
            <ChevronDown aria-hidden="true" data-open={showSafety} />
          </Button>
        </div>
        {showSafety && <SafetyBackups key={restoredCount} />}
      </div>
      {restoring !== null && (
        <RestoreDialog
          path={restoring}
          onClose={() => setRestoring(null)}
          onRestored={async () => {
            setRestoredCount((count) => count + 1);
            try {
              setLast(await workspaceClient.lastBackup());
            } catch {
              // The status is informational.
            }
            await onRestore();
          }}
        />
      )}
    </SettingsCard>
  );
}

const EXPORT_COMMAND = "ticketd export --file PATH";

function ExportCard() {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [message, setMessage] = useState("");
  async function exportWorkspace() {
    setBusy(true);
    setFailure("");
    setMessage("");
    try {
      const path = await workspaceClient.chooseSavePath({
        title: "Export ticketd workspace",
        defaultPath: `ticketd-export-${localDate()}.json`,
        filterName: "JSON",
        extension: "json",
      });
      if (path === null) return;
      try {
        await client.exportWorkspace(path);
        setMessage(`Export saved to ${path}.`);
      } catch (reason) {
        setFailure(`The export was not saved: ${String(reason)}`);
      }
    } catch (reason) {
      setFailure(`Could not open the save dialog: ${String(reason)}`);
    } finally {
      setBusy(false);
    }
  }
  async function copyCommand() {
    const failure = await writeClipboard(EXPORT_COMMAND);
    if (failure === null) setMessage("Command copied.");
    else setFailure(`Could not copy the command: ${failure}`);
  }
  return (
    <SettingsCard id="export" title="Export">
      <div className="settings-actions">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void exportWorkspace()}
        >
          Export…
        </Button>
      </div>
      {failure && (
        <p role="alert" className="settings-failure">
          {failure}
        </p>
      )}
      <p role="status" className="settings-hint">
        {message}
      </p>
      <div className="backup-footer">
        <p className="settings-hint">
          A readable JSON snapshot that includes Trash. It is not a backup and
          cannot be imported.
        </p>
        <p className="settings-hint">From the command line:</p>
        <div className="settings-actions">
          <code className="workspace-path">
            <CommandText command={EXPORT_COMMAND} />
          </code>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Copy export command"
            onClick={() => void copyCommand()}
          >
            <Copy aria-hidden="true" />
            Copy
          </Button>
        </div>
      </div>
    </SettingsCard>
  );
}

function KeyboardShortcutsCard() {
  const modifier = modifierKeyLabel();
  const shortcuts: { action: string; keys: string[][] }[] = [
    { action: "Move between tickets in a list", keys: [["↑"], ["↓"]] },
    { action: "Open the focused ticket", keys: [["Enter"]] },
    {
      action: "Create from the New ticket dialog",
      keys: [[modifier, "Enter"]],
    },
    {
      action: "Capture a thought from anywhere",
      keys: [[modifier, "Shift", "N"]],
    },
    { action: "Close the top surface", keys: [["Esc"]] },
    {
      action: "Resize the list and detail from the divider",
      keys: [["←"], ["→"]],
    },
  ];
  return (
    <SettingsCard id="keyboard-shortcuts" title="Keyboard shortcuts">
      <dl className="shortcut-list">
        {shortcuts.map((shortcut) => (
          <div key={shortcut.action} className="shortcut-row">
            <dt>{shortcut.action}</dt>
            <dd>
              {shortcut.keys.map((combo, index) => (
                <span key={combo.join("+")} className="shortcut-keys">
                  {index > 0 && <span className="settings-hint">or</span>}
                  {combo.map((key) => (
                    <Kbd key={key}>{key}</Kbd>
                  ))}
                </span>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </SettingsCard>
  );
}

const DOCUMENTATION_URL = "https://github.com/vantoan19/ticketd#readme";
const ISSUES_URL = "https://github.com/vantoan19/ticketd/issues";

function AboutCard() {
  const [failure, setFailure] = useState("");
  const open = (url: string, what: string) => {
    setFailure("");
    workspaceClient
      .openLink(url)
      .catch((reason: unknown) =>
        setFailure(`Could not open ${what}: ${String(reason)}`),
      );
  };
  return (
    <SettingsCard id="about" title="About">
      <p className="settings-label">ticketd {APP_VERSION}</p>
      <p className="settings-hint">
        Your workspace stays on this computer. ticketd has no account and works
        offline.
      </p>
      <div className="settings-actions">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => open(DOCUMENTATION_URL, "the documentation")}
        >
          <ExternalLink aria-hidden="true" />
          Documentation
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => open(ISSUES_URL, "the issue tracker")}
        >
          <ExternalLink aria-hidden="true" />
          Report an issue
        </Button>
      </div>
      {failure && (
        <p role="alert" className="settings-failure">
          {failure}
        </p>
      )}
    </SettingsCard>
  );
}

function SourceSettingsPage({
  entry,
  active,
  visible,
  heading,
}: {
  entry: SourceEntry;
  active: boolean;
  visible: boolean;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  // Mount on first visit with the latest configuration, then keep its draft and
  // preview alive while other sections are open. A restore remounts this page.
  const [visited, setVisited] = useState(visible);
  if (visible && !visited) setVisited(true);
  return (
    <div
      className={
        active ? "settings-column source-settings-column" : "settings-column"
      }
      hidden={!visible}
    >
      {active && (
        <>
          <h1 id="settings-heading" ref={heading} tabIndex={-1}>
            {entry.connector.name}
          </h1>
          <p>
            Bring matching GitHub issues into this workspace. Their title,
            description, state and comments sync inward; GitHub stays the place
            to edit them.
          </p>
        </>
      )}
      {(visible || visited) && <SourceCard entry={entry} />}
    </div>
  );
}

/** The Settings page: one centered column of cards. */
export function SettingsView({
  onRestore,
  onOpenInbox,
  selected,
}: {
  selected?: SettingsCardKey;
  onRestore: () => Promise<void>;
  onOpenInbox: () => void;
}) {
  // The parent mounts this page only while Settings is open, so every card
  // reads fresh data on each visit. A restore replaces the workspace under an
  // open page, so the Location card reads again afterwards.
  const [restores, setRestores] = useState(0);
  const { entries: sources } = useSources();
  const heading = useRef<HTMLHeadingElement>(null);
  const source = sources.find(
    (entry) => selected === `source-${entry.connector.provider}`,
  );
  // Opening Settings replaces the sidebar, which held focus; land on the title.
  useEffect(
    () => heading.current?.focus({ preventScroll: true }),
    [selected, source?.connector.provider],
  );
  return (
    <div
      className="management settings-page"
      data-source-active={source ? "true" : undefined}
    >
      {!source && (
        <div className="settings-column">
          <h1 id="settings-heading" ref={heading} tabIndex={-1}>
            Settings
          </h1>
          <p>Changes apply right away, except source rules, which you save.</p>
          <AppearanceCard />
          <AttentionCard onOpenInbox={onOpenInbox} />
          <LocationCard refreshKey={restores} />
          <AttachmentSettings key={restores} />
          <BackupsCard
            onRestore={async () => {
              setRestores((count) => count + 1);
              await onRestore();
            }}
          />
          <ExportCard />
          <CommandLineCard />
          <AgentSkillsCard />
        </div>
      )}
      {sources.map((entry) => {
        const active = source?.connector.provider === entry.connector.provider;
        return (
          <SourceSettingsPage
            key={`${restores}:${entry.connector.provider}`}
            entry={entry}
            active={active}
            visible={active || selected === undefined}
            heading={heading}
          />
        );
      })}
      {!source && (
        <div className="settings-column">
          <KeyboardShortcutsCard />
          <AboutCard />
        </div>
      )}
    </div>
  );
}
