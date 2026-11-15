import { useEffect, useState } from "react";
import { failureText } from "@/lib/api/describe-failure";
import { notificationClient } from "@/lib/api/notifications";
import {
  loadPreferences,
  setPreference,
  usePreferences,
} from "@/lib/preferences";
import { Ticket } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  SettingsList,
  SettingsListFooter,
  SettingsRow,
} from "@/features/settings/layout/SettingsList";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import "@/features/settings/pages/attention.css";

const BLOCKED_TITLE = "Notifications are blocked for ticketd";
const BLOCKED_HELP =
  "Allow them for ticketd in your system's notification settings, then turn this on again.";
const PERMISSION_HELP = `${BLOCKED_TITLE}. ${BLOCKED_HELP}`;

// Obviously generic example text; the real notification uses the ticket's own.
const EXAMPLE_TITLE = "Update the onboarding checklist";
const EXAMPLE_BODY = "T-12: reminder is due";

/** Personal attention preferences; they belong to the person on this computer. */
export function AttentionCard({ onOpenInbox }: { onOpenInbox: () => void }) {
  const { followCreated, notifyReminders } = usePreferences();
  const [followFailure, setFollowFailure] = useState("");
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
    setFollowFailure(
      setPreference("followCreated", value)
        ? ""
        : "Couldn't save the follow preference.",
    );
  }

  async function changeNotify(value: boolean) {
    setFailure("");
    if (!value) {
      if (!setPreference("notifyReminders", false))
        setFailure("Couldn't save the notification preference.");
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
        setFailure("Couldn't save the notification preference.");
    } catch (reason) {
      setPreference("notifyReminders", false);
      setFailure(failureText(reason, "ask for notification permission"));
    } finally {
      setChecking(false);
    }
  }

  return (
    <>
      <SettingsSection title="Following">
        <SettingsList>
          <SettingsRow
            variant="top"
            title="Follow tickets I create"
            titleId="follow-created-label"
            description="Tickets you create in ticketd become followed tickets. Tickets created by agents through the command line are not followed."
            trailing={
              <Switch
                aria-labelledby="follow-created-label"
                checked={followCreated}
                onCheckedChange={changeFollow}
              />
            }
          />
        </SettingsList>
        {followFailure && (
          <div className="attention-failure">
            <Alert tone="error">
              <AlertDescription>{followFailure}</AlertDescription>
            </Alert>
          </div>
        )}
      </SettingsSection>
      <SettingsSection title="Reminders">
        <SettingsList>
          <SettingsRow
            variant="top"
            title="Notify me when a reminder is due"
            titleId="notify-reminders-label"
            description="Shows a system notification while ticketd is open. Reminders that come due while it is closed appear only in the inbox."
            trailing={
              <Switch
                aria-labelledby="notify-reminders-label"
                checked={notifyReminders}
                disabled={checking}
                onCheckedChange={(value) => void changeNotify(value)}
              />
            }
          />
          {failure === PERMISSION_HELP ? (
            <div className="attention-row-extra">
              <Alert tone="attention">
                <AlertTitle>{BLOCKED_TITLE}</AlertTitle>
                <AlertDescription>{BLOCKED_HELP}</AlertDescription>
              </Alert>
            </div>
          ) : (
            failure && (
              <div className="attention-row-extra">
                <Alert tone="error">
                  <AlertDescription>{failure}</AlertDescription>
                </Alert>
              </div>
            )
          )}
          <div className="attention-row-extra attention-example">
            <p className="attention-example-label">
              What a due reminder looks like
            </p>
            <div
              className="attention-notification"
              role="img"
              aria-label={`Example notification: ${EXAMPLE_TITLE}. ${EXAMPLE_BODY}`}
            >
              <span className="attention-notification-icon" aria-hidden="true">
                <Ticket size={16} />
              </span>
              <span className="attention-notification-text">
                <span className="attention-notification-app">
                  <span>ticketd</span>
                  <span>now</span>
                </span>
                <span className="attention-notification-title">
                  {EXAMPLE_TITLE}
                </span>
                <span className="attention-notification-body">
                  {EXAMPLE_BODY}
                </span>
              </span>
            </div>
          </div>
          <SettingsListFooter>
            No notification? Allow ticketd in System Settings → Notifications.
          </SettingsListFooter>
        </SettingsList>
      </SettingsSection>
      <SettingsSection title="Inbox">
        <SettingsList>
          <SettingsRow
            title="Attention inbox"
            description="Followed tickets and due reminders collect here. Follows and reminders belong to the person on this computer."
            trailing={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onOpenInbox}
              >
                Open the Attention inbox
              </Button>
            }
          />
        </SettingsList>
      </SettingsSection>
    </>
  );
}
