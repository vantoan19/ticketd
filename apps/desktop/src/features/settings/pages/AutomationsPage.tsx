import { useEffect, useState } from "react";
import { FailureAlert } from "@/components/ui/failure-alert";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
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

/** Settings > Automations: how Automations run on this desktop. */
export function AutomationsPage() {
  return (
    <SettingsPage
      {...sectionMeta("automations")}
      titleAccessory={<Badge variant="experimental">Experimental</Badge>}
      lede="Run agents and steps on tickets without starting each one by hand. Open Automations from the sidebar to set them up."
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
  /** What the setting starts at and the most it takes, as the core has them. */
  const [limits, setLimits] = useState({ default: 0, most: 0 });
  const [confirmed, setConfirmed] = useState(false);
  const [failure, setFailure] = useState<string | FailureDescription>("");
  const [readRound, setReadRound] = useState(0);
  useEffect(() => {
    let current = true;
    automationsClient.runsAtOnce().then(
      ({ runs, ...bounds }) => {
        if (!current) return;
        setValue(String(runs));
        setSaved(runs);
        setLimits(bounds);
        setFailure("");
      },
      (reason: unknown) =>
        current && setFailure(describeFailure(reason, "read runs at once")),
    );
    return () => {
      current = false;
    };
  }, [readRound]);
  const outOfRange = `Enter a whole number from 1 to ${limits.most}.`;
  async function save(text: string) {
    const runs = Number(text);
    setConfirmed(false);
    if (!Number.isInteger(runs) || runs < 1 || runs > limits.most) {
      setFailure(outOfRange);
      return;
    }
    setFailure("");
    if (runs === saved) return;
    try {
      await automationsClient.setRunsAtOnce(runs);
      setSaved(runs);
      setConfirmed(true);
    } catch (reason) {
      setFailure(describeFailure(reason, "save runs at once"));
    }
  }
  const invalid = failure === outOfRange;
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
                  max={limits.most || undefined}
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
                (Number(value) === limits.default ? (
                  <span className="attachments-limit-note">Default</span>
                ) : (
                  <SettingsLink
                    onClick={() => {
                      setValue(String(limits.default));
                      void save(String(limits.default));
                    }}
                  >
                    Use the default, {limits.default}
                  </SettingsLink>
                ))}
              <span role="status" className="attachments-limit-note">
                {confirmed ? "Saved" : ""}
              </span>
            </div>
          }
        >
          {failure &&
            (typeof failure === "string" ? (
              <span role="alert" className="settings-failure attachments-error">
                {failure}
              </span>
            ) : (
              <FailureAlert
                size="compact"
                failure={failure}
                onRetry={() =>
                  saved === null ? setReadRound((n) => n + 1) : void save(value)
                }
              />
            ))}
        </SettingsRow>
      </SettingsList>
    </SettingsSection>
  );
}

function InTheBackground() {
  /** null until the system has answered. */
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [failure, setFailure] = useState<{
    description: FailureDescription;
    retry: () => void;
  } | null>(null);
  const [readRound, setReadRound] = useState(0);
  useEffect(() => {
    let current = true;
    automationsClient.startsAtLogin().then(
      (starts) => {
        if (current) {
          setEnabled(starts);
          setFailure(null);
        }
      },
      (reason: unknown) =>
        current &&
        setFailure({
          description: describeFailure(
            reason,
            "read the start-at-login setting",
          ),
          retry: () => setReadRound((n) => n + 1),
        }),
    );
    return () => {
      current = false;
    };
  }, [readRound]);
  const change = (starts: boolean) =>
    automationsClient.setStartsAtLogin(starts).then(
      () => {
        setEnabled(starts);
        setFailure(null);
      },
      (reason: unknown) =>
        setFailure({
          description: describeFailure(
            reason,
            `turn starting at sign-in ${starts ? "on" : "off"}`,
          ),
          retry: () => void change(starts),
        }),
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
            <FailureAlert
              size="compact"
              failure={failure.description}
              onRetry={failure.retry}
            />
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
