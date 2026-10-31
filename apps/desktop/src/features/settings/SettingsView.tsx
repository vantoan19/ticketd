import { useEffect, useState, type ReactNode } from "react";
import {
  Copy,
  ExternalLink,
  FolderOpen,
  Monitor,
  Moon,
  Sun,
} from "lucide-react";
import { RadioGroup } from "radix-ui";
import { client } from "@/lib/api/client";
import { workspaceClient, type WorkspaceInfo } from "@/lib/api/workspace";
import { Button } from "@/components/ui/button";
import { APP_VERSION } from "@/lib/app-version";
import {
  setPreference,
  usePreferences,
  type OpenTicketsPreference,
} from "@/lib/preferences";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Kbd, modifierKeyLabel } from "@/components/ui/kbd";
import {
  settingsCardId,
  type SettingsSectionId,
} from "@/features/settings/settings-sections";
import "@/features/settings/settings.css";

function SettingsCard({
  id,
  title,
  children,
}: {
  id: SettingsSectionId;
  title: string;
  children: ReactNode;
}) {
  const headingId = `${settingsCardId(id)}-heading`;
  return (
    <section
      id={settingsCardId(id)}
      className="settings-card"
      aria-labelledby={headingId}
      tabIndex={-1}
    >
      <h2 id={headingId}>{title}</h2>
      {children}
    </section>
  );
}

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
              <span className="layout-choice-label">{option.label}</span>
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

function fileManagerName() {
  const platform =
    typeof navigator === "undefined" ? "" : navigator.platform || "";
  if (/mac/i.test(platform)) return "Finder";
  if (/win/i.test(platform)) return "Explorer";
  return "File Manager";
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

function LocationCard() {
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
  }, []);
  async function copyPath(path: string) {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(path);
      setMessage("Path copied.");
    } catch (reason) {
      setMessage(`Could not copy the path: ${String(reason)}`);
    }
  }
  async function reveal(path: string) {
    try {
      await workspaceClient.reveal(path);
      setMessage("");
    } catch (reason) {
      setMessage(`Could not show the file: ${String(reason)}`);
    }
  }
  const manager = fileManagerName();
  const facts = info && [
    ["Tickets", String(info.tickets)],
    ["Projects", String(info.projects)],
    ["Active Efforts", String(info.active_efforts)],
    ["File size", formatSize(info.size_bytes)],
    ["Format version", String(info.format_version)],
  ];
  return (
    <SettingsCard id="location" title="Location">
      <p className="settings-hint">
        The desktop app and the ticketd command line read and write this same
        workspace for your user.
      </p>
      {loadFailure && (
        <p role="alert" className="settings-failure">
          {loadFailure}
        </p>
      )}
      {info && facts && (
        <>
          <p className="workspace-path" aria-label="Workspace path">
            {info.path}
          </p>
          <div className="settings-actions">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void copyPath(info.path)}
            >
              <Copy aria-hidden="true" />
              Copy path
            </Button>
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

function BackupsCard({ onRestore }: { onRestore: () => Promise<void> }) {
  const [backupPath, setBackupPath] = useState("");
  const [backupMessage, setBackupMessage] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);
  return (
    <SettingsCard id="backups" title="Backups">
      <section aria-label="Workspace backup">
        <label>
          Backup file path{" "}
          <input
            value={backupPath}
            onChange={(event) => setBackupPath(event.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={!backupPath || backupBusy}
          onClick={() =>
            void (async () => {
              setBackupBusy(true);
              try {
                setBackupMessage(await client.backupWorkspace(backupPath));
              } catch (reason) {
                setBackupMessage(`Backup failed: ${String(reason)}`);
              } finally {
                setBackupBusy(false);
              }
            })()
          }
        >
          Back up
        </button>
        <button
          type="button"
          disabled={!backupPath || backupBusy}
          onClick={() =>
            void (async () => {
              if (
                !window.confirm(
                  "Restore this backup? Current workspace data will be replaced after a safety backup is made.",
                )
              )
                return;
              setBackupBusy(true);
              try {
                setBackupMessage(await client.restoreWorkspace(backupPath));
                await onRestore();
              } catch (reason) {
                setBackupMessage(`Restore failed: ${String(reason)}`);
              } finally {
                setBackupBusy(false);
              }
            })()
          }
        >
          Restore backup
        </button>
        <p role="status">{backupMessage}</p>
      </section>
    </SettingsCard>
  );
}

function ExportCard() {
  const [exportPath, setExportPath] = useState("");
  const [exportMessage, setExportMessage] = useState("");
  return (
    <SettingsCard id="export" title="Export">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setExportMessage("");
          void client
            .exportWorkspace(exportPath)
            .then(() => setExportMessage("Export saved."))
            .catch((reason: unknown) =>
              setExportMessage(`Export failed: ${String(reason)}`),
            );
        }}
      >
        <label>
          Export file path{" "}
          <input
            className="rounded border border-neutral-400 bg-white p-2"
            value={exportPath}
            onChange={(event) => setExportPath(event.target.value)}
            required
          />
        </label>{" "}
        <button type="submit">Export workspace</button>
        {exportMessage && <p role="status">{exportMessage}</p>}
      </form>
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

/** The Settings page: one centered column of cards. */
export function SettingsView({
  onRestore,
  hidden,
}: {
  hidden: boolean;
  onRestore: () => Promise<void>;
}) {
  return (
    <div className="management settings-page" hidden={hidden}>
      <div className="settings-column">
        <h1>Settings</h1>
        <p>Changes apply right away.</p>
        <AppearanceCard />
        <LocationCard />
        <BackupsCard onRestore={onRestore} />
        <ExportCard />
        <KeyboardShortcutsCard />
        <AboutCard />
      </div>
    </div>
  );
}
