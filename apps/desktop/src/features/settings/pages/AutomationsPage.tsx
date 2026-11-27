import { useEffect, useState } from "react";
import { FailureAlert } from "@/components/ui/failure-alert";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { automationsClient } from "@/features/automations/client";
import {
  SettingsList,
  SettingsRow,
} from "@/features/settings/layout/SettingsList";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";
import { sectionMeta } from "@/features/settings/settings-sections";

/**
 * Settings > Automations: whether ticketd starts when you sign in, which
 * scheduled runs need, and the way to the Automations view. Runs at once is
 * not set here: Automations run 2 at once.
 */
export function AutomationsPage({
  onOpenAutomations,
}: {
  onOpenAutomations: () => void;
}) {
  return (
    <SettingsPage
      {...sectionMeta("automations")}
      titleAccessory={<Badge variant="experimental">Experimental</Badge>}
    >
      <StartAtLogin />
      <section className="settings-section">
        <SettingsList>
          <SettingsRow
            title="Open Automations"
            description="Build them, and choose which ones run on this computer."
            onOpen={onOpenAutomations}
            openLabel="Open Automations"
          />
        </SettingsList>
      </section>
    </SettingsPage>
  );
}

/** "2 Automations run on a schedule." as a fact, never a warning. */
function scheduleFact(count: number) {
  return count === 1
    ? "1 Automation runs on a schedule."
    : `${count} Automations run on a schedule.`;
}

function StartAtLogin() {
  /** null until the system has answered. */
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [failure, setFailure] = useState<{
    description: FailureDescription;
    retry: () => void;
  } | null>(null);
  const [readRound, setReadRound] = useState(0);
  /** How many Automations are on for this computer and start on a schedule. */
  const [scheduled, setScheduled] = useState(0);
  useEffect(() => {
    let current = true;
    // A fact for the row below; if it can't be read the row simply says less.
    automationsClient.automations().then(
      (automations) =>
        current &&
        setScheduled(
          automations.filter(
            (automation) =>
              automation.enabled && automation.trigger?.kind === "schedule",
          ).length,
        ),
      () => current && setScheduled(0),
    );
    return () => {
      current = false;
    };
  }, []);
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
    <section className="settings-section">
      <SettingsList>
        <SettingsRow
          variant="top"
          title="Start ticketd when you sign in"
          titleId="start-at-login-title"
          description="Scheduled Automations run only while ticketd is running."
          trailing={
            <Switch
              aria-labelledby="start-at-login-title"
              checked={enabled ?? false}
              disabled={enabled === null}
              onCheckedChange={(starts) => void change(starts)}
            />
          }
        >
          {enabled === false && scheduled > 0 && (
            <div className="settings-list-row-description">
              {scheduleFact(scheduled)}
            </div>
          )}
          {failure && (
            <FailureAlert
              size="compact"
              failure={failure.description}
              onRetry={failure.retry}
            />
          )}
        </SettingsRow>
      </SettingsList>
    </section>
  );
}
