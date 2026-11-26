import { FailureAlert } from "@/components/ui/failure-alert";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { DialogShell } from "@/components/ui/dialog-shell";
import { Switch } from "@/components/ui/switch";
import {
  SettingsList,
  SettingsListFooter,
  SettingsRow,
} from "@/features/settings/layout/SettingsList";
import { SettingsLink } from "@/features/settings/layout/SettingsLink";
import { useSettingsState } from "@/features/settings/use-settings-state";
import { useChatClient, type Stopping } from "@/features/chats/client";
import { stoppingText } from "@/features/chats/model";
import { useChatFeature } from "@/features/chats/use-chats";

/**
 * Settings > Agents: the Chats switch, marked Experimental. Off by default. Turning it off
 * hides Chat and keeps every Chat; Chats that are working and runs that are
 * going are stopped first, and only after the person confirms.
 */
export function ExperimentalCard() {
  const client = useChatClient();
  const { openPage } = useSettingsState();
  const { enabled, setEnabled } = useChatFeature();
  const [failure, setFailure] = useState<{
    failure: FailureDescription;
    value: boolean;
  } | null>(null);
  /**
   * What turning off would stop; set while the confirmation is open. `"unknown"`
   * when it could not be read.
   */
  const [confirming, setConfirming] = useState<Stopping | "unknown" | null>(
    null,
  );
  const apply = (value: boolean) =>
    setEnabled(value).then(
      () => setFailure(null),
      (reason: unknown) =>
        setFailure({
          failure: describeFailure(reason, `turn Chat ${value ? "on" : "off"}`),
          value,
        }),
    );
  async function change(value: boolean) {
    if (value) return apply(true);
    // Runs are counted too: their Chats are not in the Chat list (L3). If the
    // count cannot be read, ask anyway rather than stop work unannounced.
    const stopping = await client.stopping().then(
      (value) => value,
      () => "unknown" as const,
    );
    if (stopping !== "unknown" && stopping.chats + stopping.runs === 0)
      return apply(false);
    setConfirming(stopping);
  }
  const text =
    confirming !== null && confirming !== "unknown"
      ? stoppingText(confirming.chats, confirming.runs)
      : null;
  return (
    <>
      <section className="settings-section">
        <SettingsList>
          <SettingsRow
            variant="top"
            title={
              <span className="flex items-center gap-2">
                Chats
                <Badge variant="experimental">Experimental</Badge>
              </span>
            }
            titleId="chats-title"
            description="Start your agents from ticketd and follow their work beside your tickets."
            trailing={
              <Switch
                aria-labelledby="chats-title"
                checked={enabled}
                onCheckedChange={(value) => void change(value)}
              />
            }
          />
          <SettingsListFooter
            actions={
              <SettingsLink onClick={() => openPage("about")}>
                Report an issue
              </SettingsLink>
            }
          >
            Not yet tested with every subscription plan.
          </SettingsListFooter>
        </SettingsList>
        {failure && (
          <FailureAlert
            size="compact"
            failure={failure.failure}
            onRetry={() => void apply(failure.value)}
          />
        )}
      </section>
      <DialogShell
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title="Turn off Chat?"
        cancelLabel="Keep Chat on"
        primaryLabel={
          text?.one ? "Stop it and turn off" : "Stop them and turn off"
        }
        primaryVariant="destructive"
        blockedReason={null}
        onSubmit={() => {
          setConfirming(null);
          void apply(false);
        }}
      >
        <p className="chat-dialog-text">
          {text
            ? `${text.subject} working. Turning Chat off stops ${text.one ? "it" : "them"} first.`
            : "Chats and runs may be working. Turning Chat off stops them first."}
        </p>
        {confirming !== null &&
          (confirming === "unknown" || confirming.runs > 0) && (
            <p className="chat-fine">
              A stopped run ends as Needs attention. Queued runs wait until Chat
              is on again.
            </p>
          )}
        <p className="chat-fine">
          Your Chats are kept. Turn Chat back on to see them again; nothing
          restarts by itself.
        </p>
      </DialogShell>
    </>
  );
}
