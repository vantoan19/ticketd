import { useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { RadioGroup } from "radix-ui";
import { client } from "@/lib/api/client";
import { APP_VERSION } from "@/lib/app-version";
import {
  setPreference,
  usePreferences,
  type OpenTicketsPreference,
} from "@/lib/preferences";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Kbd, modifierKeyLabel } from "@/components/ui/kbd";
import { SettingsCard } from "@/features/settings/SettingsCard";
import { CommandLineCard } from "@/features/settings/CommandLineCard";
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

function AboutCard() {
  return (
    <SettingsCard id="about" title="About">
      <p className="settings-label">ticketd {APP_VERSION}</p>
      <p className="settings-hint">
        Your workspace stays on this computer. ticketd has no account and works
        offline.
      </p>
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
        <BackupsCard onRestore={onRestore} />
        <ExportCard />
        <CommandLineCard />
        <KeyboardShortcutsCard />
        <AboutCard />
      </div>
    </div>
  );
}
