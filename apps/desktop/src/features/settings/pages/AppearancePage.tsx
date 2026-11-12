import { useState } from "react";
import {
  setPreference,
  useDarkTheme,
  usePreferences,
  type OpenTicketsPreference,
} from "@/lib/preferences";
import { ChoiceTile, ChoiceTiles } from "@/components/ui/choice-tiles";
import { sectionMeta } from "@/features/settings/settings-sections";
import {
  AppliesRightAway,
  SettingsPage,
} from "@/features/settings/layout/SettingsPage";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import "@/features/settings/pages/appearance.css";

type Resolved = "light" | "dark";

/** The side rail and pane every miniature shares, drawn from the theme's tokens. */
function MiniScreen({
  theme,
  cut = false,
  children,
}: {
  theme: Resolved;
  cut?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className="mini-screen"
      data-theme-preview={theme}
      data-cut={cut || undefined}
    >
      <span className="mini-side">
        <i data-on="" />
        <i />
        <i />
        <i style={{ width: "60%" }} />
      </span>
      <span className="mini-pane">{children}</span>
    </span>
  );
}

function Line({
  width,
  head = false,
  ok = false,
  selected = false,
}: {
  width: string;
  head?: boolean;
  ok?: boolean;
  selected?: boolean;
}) {
  return (
    <span className="mini-line" data-selected={selected || undefined}>
      <s data-ok={ok || undefined} />
      <b data-head={head || undefined} style={{ width }} />
    </span>
  );
}

function ListLines() {
  return (
    <>
      <Line head width="62%" />
      <Line width="48%" />
      <Line ok width="70%" />
      <Line width="40%" />
      <Line width="56%" />
    </>
  );
}

function Mini({ children }: { children: React.ReactNode }) {
  return (
    <span className="mini" aria-hidden="true">
      {children}
    </span>
  );
}

function ThemeMini({ theme }: { theme: "system" | Resolved }) {
  if (theme === "system")
    return (
      <Mini>
        <MiniScreen theme="light">
          <ListLines />
        </MiniScreen>
        <MiniScreen theme="dark" cut>
          <ListLines />
        </MiniScreen>
      </Mini>
    );
  return (
    <Mini>
      <MiniScreen theme={theme}>
        <ListLines />
      </MiniScreen>
    </Mini>
  );
}

function OpenMini({
  kind,
  theme,
}: {
  kind: OpenTicketsPreference;
  theme: Resolved;
}) {
  return (
    <Mini>
      <MiniScreen theme={theme}>
        <span className="mini-split">
          {kind === "split" && (
            <span className="mini-list">
              <Line selected head width="70%" />
              <Line width="56%" />
              <Line ok width="76%" />
              <Line width="48%" />
            </span>
          )}
          <span
            className="mini-detail"
            data-full={kind === "expanded" || undefined}
          >
            <b
              data-head=""
              style={{ width: kind === "split" ? "70%" : "40%" }}
            />
            <b style={{ width: "92%" }} />
            <b style={{ width: "84%" }} />
            <b style={{ width: kind === "split" ? "60%" : "52%" }} />
          </span>
        </span>
      </MiniScreen>
    </Mini>
  );
}

export function AppearancePage() {
  const { theme, openTickets } = usePreferences();
  const dark = useDarkTheme();
  const resolved: Resolved = dark ? "dark" : "light";
  const [failure, setFailure] = useState("");
  const report = (saved: boolean, what: string) =>
    setFailure(saved ? "" : `Could not save ${what}.`);
  return (
    <SettingsPage
      {...sectionMeta("appearance")}
      lede="How ticketd looks on this computer."
      endSlot={<AppliesRightAway />}
    >
      <SettingsSection
        title="Theme"
        caption="System follows your operating system. Light and Dark override it."
      >
        <ChoiceTiles
          aria-label="Theme"
          columns={3}
          value={theme}
          onValueChange={(value) =>
            report(
              setPreference("theme", value as "system" | Resolved),
              "the theme",
            )
          }
        >
          <ChoiceTile
            value="system"
            title="System"
            description={dark ? "Dark right now" : "Light right now"}
            preview={<ThemeMini theme="system" />}
          />
          <ChoiceTile
            value="light"
            title="Light"
            description="Always light"
            preview={<ThemeMini theme="light" />}
          />
          <ChoiceTile
            value="dark"
            title="Dark"
            description="Always dark"
            preview={<ThemeMini theme="dark" />}
          />
        </ChoiceTiles>
      </SettingsSection>
      <SettingsSection
        title="Open tickets"
        caption="Applies to the next ticket you open from a list."
      >
        <ChoiceTiles
          aria-label="Open tickets"
          value={openTickets}
          onValueChange={(value) =>
            report(
              setPreference("openTickets", value as OpenTicketsPreference),
              "the Open tickets choice",
            )
          }
        >
          <ChoiceTile
            value="split"
            title="Beside the list"
            description="Split view. The list stays in view while you read."
            preview={<OpenMini kind="split" theme={resolved} />}
          />
          <ChoiceTile
            value="expanded"
            title="Full width"
            description="Expanded view. The ticket takes the whole pane."
            preview={<OpenMini kind="expanded" theme={resolved} />}
          />
        </ChoiceTiles>
        {failure && (
          <p role="alert" className="settings-failure appearance-failure">
            {failure}
          </p>
        )}
      </SettingsSection>
    </SettingsPage>
  );
}
