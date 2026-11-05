import { useEffect, useState } from "react";
import { notificationClient } from "@/lib/api/notifications";
import {
  loadPreferences,
  setPreference,
  usePreferences,
} from "@/lib/preferences";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SettingsCard } from "@/features/settings/SettingsCard";

const PERMISSION_HELP =
  "Notifications are blocked for ticketd. Allow them for ticketd in your system's notification settings, then turn this on again.";

/** Personal attention preferences; they belong to the person on this computer. */
export function AttentionCard({ onOpenInbox }: { onOpenInbox: () => void }) {
  const { followCreated, notifyReminders } = usePreferences();
  const [failure, setFailure] = useState("");
  const [checking, setChecking] = useState(false);

  // Permission can be withdrawn in system settings; never show a switch that
  // promises notifications the system will drop. Checked once on opening.
  useEffect(() => {
    if (!loadPreferences().notifyReminders) return;
    let current = true;
    notificationClient
      .permitted()
      .then((granted) => {
        if (current && !granted) {
          setPreference("notifyReminders", false);
          setFailure(PERMISSION_HELP);
        }
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, []);

  function changeFollow(value: boolean) {
    setFailure(
      setPreference("followCreated", value)
        ? ""
        : "Could not save the follow preference.",
    );
  }

  async function changeNotify(value: boolean) {
    setFailure("");
    if (!value) {
      if (!setPreference("notifyReminders", false))
        setFailure("Could not save the notification preference.");
      return;
    }
    setChecking(true);
    try {
      if (!(await notificationClient.requestPermission())) {
        setPreference("notifyReminders", false);
        setFailure(PERMISSION_HELP);
        return;
      }
      if (!setPreference("notifyReminders", true))
        setFailure("Could not save the notification preference.");
    } catch (reason) {
      setPreference("notifyReminders", false);
      setFailure(
        `Could not ask for notification permission: ${String(reason)}`,
      );
    } finally {
      setChecking(false);
    }
  }

  return (
    <SettingsCard id="attention" title="Attention">
      <div className="settings-row">
        <div>
          <p className="settings-label" id="follow-created-label">
            Follow tickets I create
          </p>
          <p className="settings-hint">
            Tickets you create in ticketd become followed tickets. Tickets
            created by agents through the command line are not followed.
          </p>
        </div>
        <Switch
          aria-labelledby="follow-created-label"
          checked={followCreated}
          onCheckedChange={changeFollow}
        />
      </div>
      <div className="settings-row">
        <div>
          <p className="settings-label" id="notify-reminders-label">
            Notify me when a reminder is due
          </p>
          <p className="settings-hint">
            Shows a system notification while ticketd is open. Reminders that
            come due while it is closed appear only in the inbox. If no
            notification appears, allow ticketd in System Settings →
            Notifications.
          </p>
        </div>
        <Switch
          aria-labelledby="notify-reminders-label"
          checked={notifyReminders}
          disabled={checking}
          onCheckedChange={(value) => void changeNotify(value)}
        />
      </div>
      {failure && (
        <p role="alert" className="settings-failure">
          {failure}
        </p>
      )}
      <div className="settings-footer-row">
        <p className="settings-hint">
          Follows and reminders belong to the person on this computer.
        </p>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onOpenInbox}
        >
          Open the Attention inbox
        </Button>
      </div>
    </SettingsCard>
  );
}
