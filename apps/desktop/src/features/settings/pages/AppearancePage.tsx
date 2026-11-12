import { useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { RadioGroup } from "radix-ui";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  setPreference,
  usePreferences,
  type OpenTicketsPreference,
} from "@/lib/preferences";
import { SettingsCard } from "@/features/settings/SettingsCard";
import { sectionMeta } from "@/features/settings/settings-sections";
import {
  AppliesRightAway,
  SettingsPage,
} from "@/features/settings/layout/SettingsPage";

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

export function AppearancePage() {
  return (
    <SettingsPage
      {...sectionMeta("appearance")}
      lede="How ticketd looks on this computer."
      endSlot={<AppliesRightAway />}
    >
      <AppearanceCard />
    </SettingsPage>
  );
}
