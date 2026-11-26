import { useState } from "react";
import {
  setPreference,
  useSystemDark,
  usePreferences,
  type OpenTicketsPreference,
} from "@/lib/preferences";
import { ChoiceTile, ChoiceTiles } from "@/components/ui/choice-tiles";
import { FailureAlert } from "@/components/ui/failure-alert";
import { sectionMeta } from "@/features/settings/settings-sections";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import "@/features/settings/pages/appearance.css";

type Resolved = "light" | "dark";

/** Small token-scoped windows; System shows its light and dark halves together. */
function MiniScreen({ theme }: { theme: Resolved }) {
  return (
    <span className="mini-screen" data-theme-preview={theme}>
      <span className="mini-side">
        <i />
        <i data-on="" />
        <i />
      </span>
      <span className="mini-pane">
        <b data-head="" />
        <b />
        <b />
        <b />
      </span>
    </span>
  );
}
function ThemeMini({ theme }: { theme: "system" | Resolved }) {
  return (
    <span
      className="mini"
      data-system={theme === "system" || undefined}
      aria-hidden="true"
    >
      {theme === "system" ? (
        <>
          <MiniScreen theme="light" />
          <MiniScreen theme="dark" />
        </>
      ) : (
        <MiniScreen theme={theme} />
      )}
    </span>
  );
}

export function AppearancePage() {
  const { theme, openTickets } = usePreferences();
  const systemDark = useSystemDark();
  // A choice that was not saved, shown under the group it belongs to.
  const [failure, setFailure] = useState<{
    group: "theme" | "open";
    what: string;
  } | null>(null);
  const report = (saved: boolean, group: "theme" | "open", what: string) =>
    setFailure(saved ? null : { group, what });
  const failed = (group: "theme" | "open") =>
    failure?.group === group && (
      <FailureAlert
        size="compact"
        className="mt-3"
        failure={{
          code: "failed",
          title: `Couldn't save ${failure.what}`,
          sentence: "The previous choice stays.",
          action: null,
          details: "",
        }}
      />
    );
  return (
    <SettingsPage {...sectionMeta("appearance")}>
      <SettingsSection
        title="Theme"
        caption={`System follows your operating system${systemDark === null ? "." : systemDark ? ", and is dark right now." : ", and is light right now."}`}
      >
        <ChoiceTiles
          aria-label="Theme"
          variant="preview"
          columns={3}
          value={theme}
          onValueChange={(value) =>
            report(
              setPreference("theme", value as "system" | Resolved),
              "theme",
              "the theme",
            )
          }
        >
          <ChoiceTile
            value="system"
            title="System"
            preview={<ThemeMini theme="system" />}
          />
          <ChoiceTile
            value="light"
            title="Light"
            preview={<ThemeMini theme="light" />}
          />
          <ChoiceTile
            value="dark"
            title="Dark"
            preview={<ThemeMini theme="dark" />}
          />
        </ChoiceTiles>
        {failed("theme")}
      </SettingsSection>
      <SettingsSection
        title="Open tickets"
        caption="Applies the next time you open a ticket from a list."
      >
        <ChoiceTiles
          aria-label="Open tickets"
          variant="rows"
          value={openTickets}
          onValueChange={(value) =>
            report(
              setPreference("openTickets", value as OpenTicketsPreference),
              "open",
              "the Open tickets choice",
            )
          }
        >
          <ChoiceTile
            value="split"
            title="Beside the list"
            description="The list narrows so you can move with J and K while you read."
          />
          <ChoiceTile
            value="expanded"
            title="Full width"
            description="The ticket takes the whole panel; Esc returns to the list."
          />
        </ChoiceTiles>
        {failed("open")}
      </SettingsSection>
    </SettingsPage>
  );
}
