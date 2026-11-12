import { useState } from "react";
import { Search } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { modifierKeyLabel } from "@/lib/platform";
import { sectionMeta } from "@/features/settings/settings-sections";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import {
  SettingsList,
  SettingsRow,
} from "@/features/settings/layout/SettingsList";
import "@/features/settings/pages/shortcuts-page.css";

interface Shortcut {
  action: string;
  note?: string;
  /** Alternatives, each a chord of keys pressed together. */
  keys: string[][];
}
interface Group {
  name: string;
  caption?: string;
  shortcuts: Shortcut[];
}

function groups(modifier: string): Group[] {
  return [
    {
      name: "Lists",
      caption: "In any list of tickets.",
      shortcuts: [
        { action: "Move between tickets in a list", keys: [["↑"], ["↓"]] },
        { action: "Open the focused ticket", keys: [["Enter"]] },
        {
          action: "Resize the list and detail from the divider",
          note: "Focus the divider first.",
          keys: [["←"], ["→"]],
        },
      ],
    },
    {
      name: "Creating",
      caption: "Capture works wherever you are in ticketd.",
      shortcuts: [
        {
          action: "Create from the New ticket dialog",
          keys: [[modifier, "Enter"]],
        },
        {
          action: "Capture a thought from anywhere",
          keys: [[modifier, "Shift", "N"]],
        },
      ],
    },
    {
      name: "Dialogs and menus",
      shortcuts: [
        {
          action: "Close the top surface",
          note: "Closes only the foremost dialog, menu or sheet, and never throws away a draft.",
          keys: [["Esc"]],
        },
      ],
    },
  ];
}

const SPOKEN: Record<string, string> = {
  "⌘": "Command",
  Ctrl: "Control",
  "↑": "Up arrow",
  "↓": "Down arrow",
  "←": "Left arrow",
  "→": "Right arrow",
  Esc: "Escape",
};

/** What a screen reader says for the keys: "Command plus Shift plus N". */
function spoken(keys: string[][]) {
  return keys
    .map((chord) => chord.map((key) => SPOKEN[key] ?? key).join(" plus "))
    .join(" or ");
}

function matches(shortcut: Shortcut, group: Group, query: string) {
  const text = [
    shortcut.action,
    shortcut.note ?? "",
    spoken(shortcut.keys),
    group.name,
  ]
    .join(" ")
    .toLowerCase();
  return text.includes(query);
}

function Keys({ keys }: { keys: string[][] }) {
  return (
    <span role="img" aria-label={spoken(keys)} className="shortcut-keys">
      {keys.map((chord, index) => (
        <span key={chord.join("+")} className="shortcut-chord">
          {index > 0 && (
            <span aria-hidden="true" className="shortcut-or">
              or
            </span>
          )}
          {chord.map((key) => (
            <Kbd key={key} aria-hidden="true">
              {key}
            </Kbd>
          ))}
        </span>
      ))}
    </span>
  );
}

export function KeyboardShortcutsPage() {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const visible = groups(modifierKeyLabel())
    .map((group) => ({
      ...group,
      shortcuts: group.shortcuts.filter(
        (shortcut) => !needle || matches(shortcut, group, needle),
      ),
    }))
    .filter((group) => group.shortcuts.length > 0);
  return (
    <SettingsPage
      {...sectionMeta("keyboard-shortcuts")}
      lede="Keys that work across ticketd."
    >
      <div className="shortcut-filter">
        <Search size={16} aria-hidden="true" />
        <Input
          type="text"
          aria-label="Filter shortcuts"
          placeholder="Filter shortcuts, for example resize"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {visible.map((group) => (
        <SettingsSection
          key={group.name}
          title={group.name}
          {...(group.caption ? { caption: group.caption } : {})}
        >
          <SettingsList>
            {group.shortcuts.map((shortcut) => (
              <SettingsRow
                key={shortcut.action}
                tight
                title={shortcut.action}
                {...(shortcut.note ? { description: shortcut.note } : {})}
                trailing={<Keys keys={shortcut.keys} />}
              />
            ))}
          </SettingsList>
        </SettingsSection>
      ))}
      {visible.length === 0 && (
        <div className="shortcut-none">
          <SettingsList>
            <EmptyState
              role="status"
              title={`No shortcuts match “${query.trim()}”`}
              action={
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setQuery("")}
                >
                  Clear filter
                </Button>
              }
            />
          </SettingsList>
        </div>
      )}
    </SettingsPage>
  );
}
