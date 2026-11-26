import { useEffect, useState } from "react";
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  SettingsList,
  SettingsRow,
} from "@/features/settings/layout/SettingsList";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import { notificationClient } from "@/lib/api/notifications";
import { setPreference, usePreferences } from "@/lib/preferences";

/**
 * Settings > Agents > Notifications: the one switch for system notifications
 * about Chats not in view. Per-Chat mute lives in the Chat actions menu. When
 * the system blocks ticketd the switch reads off until Check again finds it
 * allowed; the person's choice is kept meanwhile.
 */
export function NotificationsCard() {
  const { notifyChats } = usePreferences();
  const [blocked, setBlocked] = useState(false);
  const [failure, setFailure] = useState("");
  const [checking, setChecking] = useState(false);

  async function check(ask: boolean) {
    setChecking(true);
    try {
      const allowed = ask
        ? await notificationClient.requestPermission()
        : await notificationClient.permitted();
      setBlocked(!allowed);
      return allowed;
    } catch {
      setBlocked(true);
      return false;
    } finally {
      setChecking(false);
    }
  }

  // Permission can be withdrawn in system settings; checked once on opening.
  useEffect(() => {
    if (!notifyChats) return;
    let current = true;
    notificationClient.permitted().then(
      (allowed) => current && setBlocked(!allowed),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [notifyChats]);

  async function change(value: boolean) {
    setFailure("");
    if (!setPreference("notifyChats", value)) {
      setFailure("Could not save the notification preference.");
      return;
    }
    if (value) await check(true);
    else setBlocked(false);
  }

  return (
    <SettingsSection
      title="Notifications"
      caption="For Chats you aren't looking at."
    >
      <SettingsList>
        <SettingsRow
          variant="top"
          title="Notify me about Chats"
          titleId="notify-chats-title"
          description="Approvals, questions, failures and finished turns."
          trailing={
            <Switch
              aria-labelledby="notify-chats-title"
              checked={notifyChats && !blocked}
              disabled={checking}
              onCheckedChange={(value) => void change(value)}
            />
          }
        />
        {notifyChats && blocked && (
          <div className="chat-settings-extra">
            <Alert tone="attention">
              <AlertTitle>Notifications are blocked</AlertTitle>
              <AlertDescription>
                Allow ticketd in System Settings › Notifications.
              </AlertDescription>
              <AlertActions>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={checking}
                  onClick={() => void check(false)}
                >
                  Check again
                </Button>
              </AlertActions>
            </Alert>
          </div>
        )}
      </SettingsList>
      {failure && (
        <p className="mt-3 text-xs leading-4 text-destructive" role="alert">
          {failure}
        </p>
      )}
    </SettingsSection>
  );
}
