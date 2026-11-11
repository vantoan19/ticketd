import { useState } from "react";
import { DialogShell } from "@/components/ui/dialog-shell";
import { Switch } from "@/components/ui/switch";
import { SettingsCard } from "@/features/settings/SettingsCard";
import { useChatClient } from "@/features/chats/client";
import { chatCount } from "@/features/chats/model";
import { useChatFeature } from "@/features/chats/use-chats";

/**
 * Settings > Experimental: the Chat switch. Off by default. Turning it off
 * hides Chat and keeps every Chat; Chats that are working are stopped first,
 * and only after the person confirms.
 */
export function ExperimentalCard() {
  const client = useChatClient();
  const { enabled, setEnabled } = useChatFeature();
  const [failure, setFailure] = useState("");
  /** How many Chats turning off would stop; set while the confirmation is open. */
  const [confirming, setConfirming] = useState<number | null>(null);
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
    // If the count cannot be read, ask anyway rather than stop work unannounced.
    const working = await client.overview().then(
      (overview) => overview.working,
      () => null,
    );
    if (working === 0) return apply(false);
    setConfirming(working ?? -1);
  }
  return (
    <SettingsCard
      id="experimental"
      title="Experimental"
      footer={
        <p className="settings-hint">
          Turning Chat off hides it and keeps your Chats. Running Chats are
          stopped first, after you confirm.
        </p>
      }
    >
      <div className="settings-row">
        <div>
          <p className="settings-label">Chat</p>
          <p className="settings-hint">
            Work with Claude Code or Codex from ticketd, using the copy
            installed on this computer. Chat is not yet qualified against real
            subscriptions.
          </p>
        </div>
        <Switch
          aria-label="Chat"
          checked={enabled}
          onCheckedChange={(value) => void change(value)}
        />
      </div>
      {failure && (
        <p className="settings-hint" role="alert">
          {failure}
        </p>
      )}
      <DialogShell
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title="Turn off Chat?"
        cancelLabel="Keep Chat on"
        primaryLabel="Stop Chats and turn off"
        primaryVariant="destructive"
        blockedReason={null}
        onSubmit={() => {
          setConfirming(null);
          void apply(false);
        }}
      >
        <p className="chat-dialog-text">
          {confirming === null || confirming < 0
            ? "Chats may be working."
            : `${chatCount(confirming)} ${confirming === 1 ? "is" : "are"} working.`}{" "}
          Turning Chat off stops them first.
        </p>
        <p className="chat-fine">
          Your Chats are kept. Turn Chat back on to see them again; nothing
          restarts by itself.
        </p>
      </DialogShell>
    </SettingsCard>
  );
}
