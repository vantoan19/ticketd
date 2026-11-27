import { useState } from "react";
import { failureText } from "@/lib/api/describe-failure";
import { notificationClient } from "@/lib/api/notifications";
import {
  requestNotificationPermission,
  useNotificationPermission,
} from "@/lib/notification-permission";
import { setPreference, usePreferences } from "@/lib/preferences";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { StatusLabel } from "@/components/ui/status-label";
import { Switch } from "@/components/ui/switch";
import { useChatFeature } from "@/features/chats/use-chats";
import {
  SettingsList,
  SettingsRow,
} from "@/features/settings/layout/SettingsList";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import "@/features/settings/pages/attention.css";

/** Personal attention preferences; they belong to the person on this computer. */
export function AttentionCard() {
  const { followCreated, notifyChats } = usePreferences();
  const { enabled: chatsOn } = useChatFeature();
  const permission = useNotificationPermission();
  const allowed = permission?.state === "allowed";
  const [followFailure, setFollowFailure] = useState("");
  const [chatFailure, setChatFailure] = useState("");
  const [permissionFailure, setPermissionFailure] = useState("");
  const [asking, setAsking] = useState(false);

  function changeFollow(value: boolean) {
    setFollowFailure(
      setPreference("followCreated", value)
        ? ""
        : "Couldn't save the follow preference.",
    );
  }

  function changeChats(value: boolean) {
    setChatFailure(
      setPreference("notifyChats", value)
        ? ""
        : "Couldn't save the notification preference.",
    );
  }

  async function allow() {
    setPermissionFailure("");
    setAsking(true);
    try {
      await requestNotificationPermission();
    } catch (reason) {
      setPermissionFailure(
        failureText(reason, "ask for notification permission"),
      );
    } finally {
      setAsking(false);
    }
  }

  async function openSettings() {
    setPermissionFailure("");
    try {
      await notificationClient.openSettings();
    } catch (reason) {
      setPermissionFailure(failureText(reason, "open System Settings"));
    }
  }

  const blocked = permission?.state === "blocked";
  // Windows and Linux cannot read the system's setting: "allowed" is then a
  // fallback (ticketd tries to notify), not an answer from the system.
  const unreported = allowed && !permission.reported;
  const what = chatsOn
    ? "Due reminders, and Chats that need you, while ticketd is open."
    : "Due reminders while ticketd is open.";

  return (
    <>
      <SettingsSection
        title="Following"
        caption="Follows and reminders stay on this computer."
      >
        <SettingsList>
          <SettingsRow
            variant="top"
            title="Follow tickets I create"
            titleId="follow-created-label"
            description="Changes to them reach your Inbox. Tickets agents create aren’t followed."
            trailing={
              <Switch
                aria-labelledby="follow-created-label"
                checked={followCreated}
                onCheckedChange={changeFollow}
              />
            }
          >
            {followFailure && (
              <div className="attention-failure">
                <Alert tone="error" size="compact">
                  <AlertDescription>{followFailure}</AlertDescription>
                </Alert>
              </div>
            )}
          </SettingsRow>
        </SettingsList>
      </SettingsSection>
      <SettingsSection title="Notifications">
        <SettingsList>
          <SettingsRow
            title="System notifications"
            description={
              blocked
                ? "Off for ticketd in System Settings › Notifications."
                : unreported
                  ? `${what} This system doesn’t say whether notifications are on.`
                  : what
            }
            trailing={
              permission === null ? null : permission.state === "allowed" ? (
                permission.reported ? (
                  <StatusLabel tone="positive">Allowed</StatusLabel>
                ) : (
                  <StatusLabel tone="neutral">Not reported</StatusLabel>
                )
              ) : permission.state === "not_asked" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  busy={asking}
                  onClick={() => void allow()}
                >
                  Allow notifications
                </Button>
              ) : (
                <>
                  <StatusLabel tone="attention">Blocked</StatusLabel>
                  {permission.settings && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void openSettings()}
                    >
                      Open System Settings
                    </Button>
                  )}
                </>
              )
            }
          >
            {permissionFailure && (
              <div className="attention-failure">
                <Alert tone="error" size="compact">
                  <AlertDescription>{permissionFailure}</AlertDescription>
                </Alert>
              </div>
            )}
          </SettingsRow>
          {chatsOn && (
            <SettingsRow
              variant="top"
              title="Chat notifications"
              titleId="notify-chats-label"
              description="Approvals, questions, failures and finished turns. Mute one Chat from its menu."
              trailing={
                // Never a switch that promises what the system drops: until
                // notifications are allowed it reads off. The choice is kept.
                <Switch
                  aria-labelledby="notify-chats-label"
                  checked={allowed && notifyChats}
                  disabled={!allowed}
                  onCheckedChange={changeChats}
                />
              }
            >
              {chatFailure && (
                <div className="attention-failure">
                  <Alert tone="error" size="compact">
                    <AlertDescription>{chatFailure}</AlertDescription>
                  </Alert>
                </div>
              )}
            </SettingsRow>
          )}
        </SettingsList>
      </SettingsSection>
    </>
  );
}
