import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { automationsClient } from "@/features/automations/client";
import { SettingsLink } from "@/features/settings/layout/SettingsLink";
import {
  SettingsList,
  SettingsListFooter,
  SettingsRow,
} from "@/features/settings/layout/SettingsList";
import {
  AppliesRightAway,
  SettingsPage,
} from "@/features/settings/layout/SettingsPage";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import { sectionMeta } from "@/features/settings/settings-sections";
import "@/features/settings/pages/attachments.css";

const DEFAULT_RUNS = 2;
const MOST_RUNS = 10;
const OUT_OF_RANGE = `Enter a whole number from 1 to ${MOST_RUNS}.`;

/** Settings > Automations: how Automations run on this desktop. */
export function AutomationsPage() {
  return (
    <SettingsPage
      {...sectionMeta("automations")}
      titleAccessory={<Badge size="sm">Experimental</Badge>}
      lede="Run agents and steps on tickets without starting each one by hand. You set them up from Automations in the sidebar."
      endSlot={<AppliesRightAway />}
    >
      <RunsAtOnce />
      <InTheBackground />
    </SettingsPage>
  );
}

function RunsAtOnce() {
  const [value, setValue] = useState("");
  /** null until the setting is read. */
  const [saved, setSaved] = useState<number | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [failure, setFailure] = useState("");
  useEffect(() => {
    let current = true;
    automationsClient.runsAtOnce().then(
      (runs) => {
        if (!current) return;
        setValue(String(runs));
        setSaved(runs);
      },
      (reason: unknown) =>
        current && setFailure(`Could not read runs at once: ${String(reason)}`),
    );
    return () => {
      current = false;
    };
  }, []);
  async function save(text: string) {
    const runs = Number(text);
    setConfirmed(false);
    if (!Number.isInteger(runs) || runs < 1 || runs > MOST_RUNS) {
      setFailure(OUT_OF_RANGE);
      return;
    }
    setFailure("");
    if (runs === saved) return;
    try {
      await automationsClient.setRunsAtOnce(runs);
      setSaved(runs);
      setConfirmed(true);
    } catch (reason) {
      setFailure(`Could not save runs at once: ${String(reason)}`);
    }
  }
  const invalid = failure === OUT_OF_RANGE;
  return (
    <SettingsSection title="Runs">
      <SettingsList>
        <SettingsRow
          variant="top"
          title={<Label htmlFor="automation-runs-at-once">Runs at once</Label>}
          description="Runs beyond this wait in a queue, in the order their events happened."
          descriptionId="automation-runs-at-once-description"
          trailing={
            <div className="attachments-limit">
              <span className="attachments-limit-field">
                <Input
                  id="automation-runs-at-once"
                  className="w-24 text-right"
                  type="number"
                  min={1}
                  max={MOST_RUNS}
                  step={1}
                  value={value}
                  disabled={saved === null}
                  aria-invalid={invalid || undefined}
                  aria-describedby="automation-runs-at-once-description"
                  onChange={(event) => {
                    setValue(event.target.value);
                    setConfirmed(false);
                  }}
                  onBlur={() => void save(value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
              </span>
              {saved !== null &&
                !invalid &&
                (Number(value) === DEFAULT_RUNS ? (
                  <span className="attachments-limit-note">Default</span>
                ) : (
                  <SettingsLink
                    onClick={() => {
                      setValue(String(DEFAULT_RUNS));
                      void save(String(DEFAULT_RUNS));
                    }}
                  >
                    Use the default, {DEFAULT_RUNS}
                  </SettingsLink>
                ))}
              <span role="status" className="attachments-limit-note">
                {confirmed ? "Saved" : ""}
              </span>
            </div>
          }
        >
          {failure && (
            <span role="alert" className="settings-failure attachments-error">
              {failure}
            </span>
          )}
        </SettingsRow>
      </SettingsList>
    </SettingsSection>
  );
}

function InTheBackground() {
  /** null until the system has answered. */
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [failure, setFailure] = useState("");
  useEffect(() => {
    let current = true;
    automationsClient.startsAtLogin().then(
      (starts) => current && setEnabled(starts),
      (reason: unknown) =>
        current &&
        setFailure(`Could not read whether ticketd starts: ${String(reason)}`),
    );
    return () => {
      current = false;
    };
  }, []);
  const change = (starts: boolean) =>
    automationsClient.setStartsAtLogin(starts).then(
      () => {
        setEnabled(starts);
        setFailure("");
      },
      (reason: unknown) =>
        setFailure(
          `Could not turn starting at sign-in ${starts ? "on" : "off"}: ${reason instanceof Error ? reason.message : String(reason)}`,
        ),
    );
  return (
    <SettingsSection title="In the background">
      <SettingsList>
        <SettingsRow
          variant="top"
          title="Start ticketd when you sign in"
          titleId="start-at-login-title"
          description="Automations run only while ticketd is running."
          trailing={
            <Switch
              aria-labelledby="start-at-login-title"
              checked={enabled ?? false}
              disabled={enabled === null}
              onCheckedChange={(starts) => void change(starts)}
            />
          }
        >
          {failure && (
            <span role="alert" className="settings-failure attachments-error">
              {failure}
            </span>
          )}
        </SettingsRow>
        <SettingsListFooter>
          While an Automation is on, closing the window keeps ticketd running in
          the tray, as it does for a working Chat. Quit from the tray icon to
          stop everything.
        </SettingsListFooter>
      </SettingsList>
    </SettingsSection>
  );
}
