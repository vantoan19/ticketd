import { useState } from "react";
import { FlaskConical } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
 * Settings > Chat: the notice and the Show Chat switch. Off by default. Turning it off
 * hides Chat and keeps every Chat; Chats that are working and runs that are
 * going are stopped first, and only after the person confirms.
 */
export function ExperimentalCard() {
  const client = useChatClient();
  const { openPage } = useSettingsState();
  const { enabled, setEnabled } = useChatFeature();
  const [failure, setFailure] = useState("");
  /**
   * What turning off would stop; set while the confirmation is open. `"unknown"`
   * when it could not be read.
   */
  const [confirming, setConfirming] = useState<Stopping | "unknown" | null>(
    null,
  );
  const apply = (value: boolean) =>
    setEnabled(value).then(
      () => setFailure(""),
      (reason: unknown) =>
        setFailure(
          `Could not turn Chat ${value ? "on" : "off"}: ${reason instanceof Error ? reason.message : String(reason)}`,
        ),
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
      <Alert role="note" className="mt-10">
        <AlertTitle>
          <FlaskConical aria-hidden="true" size={16} />
          Not yet qualified against real subscriptions
        </AlertTitle>
        <AlertDescription>
          If something breaks, tell us from{" "}
          <SettingsLink onClick={() => openPage("about")}>
            About › Report an issue
          </SettingsLink>
          .
        </AlertDescription>
      </Alert>
      {/* The page is Chat already: its one row needs no "Chat" heading (LIVE-21). */}
      <div className="settings-section">
        <SettingsList>
          <SettingsRow
            variant="top"
            title="Show Chat"
            titleId="show-chat-title"
            description="Adds Chats and Automations to the sidebar, where you start and follow your agents’ work."
            trailing={
              <Switch
                aria-labelledby="show-chat-title"
                checked={enabled}
                onCheckedChange={(value) => void change(value)}
              />
            }
          />
          <SettingsListFooter>
            Turning Chat off hides Chats and Automations and keeps them. Running
            Chats and runs are stopped first, after you confirm.
          </SettingsListFooter>
        </SettingsList>
        {failure && (
          <p className="mt-3 text-xs leading-4 text-destructive" role="alert">
            {failure}
          </p>
        )}
      </div>
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
        <p className="chat-fine">
          Your Chats are kept. Turn Chat back on to see them again; nothing
          restarts by itself.
        </p>
      </DialogShell>
    </>
  );
}
