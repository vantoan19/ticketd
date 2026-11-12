import { Kbd } from "@/components/ui/kbd";
import { modifierKeyLabel } from "@/lib/platform";
import { SettingsCard } from "@/features/settings/SettingsCard";
import { sectionMeta } from "@/features/settings/settings-sections";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";

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

export function KeyboardShortcutsPage() {
  return (
    <SettingsPage
      {...sectionMeta("keyboard-shortcuts")}
      lede="Keys that work across ticketd."
    >
      <KeyboardShortcutsCard />
    </SettingsPage>
  );
}
