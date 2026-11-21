import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { DialogShell } from "@/components/ui/dialog-shell";
import { FailureAlert } from "@/components/ui/failure-alert";
import { describeFailure } from "@/lib/api/describe-failure";
import { plural } from "@/lib/format";
import { updateClient, type RunningWork, type UpdateInfo } from "./client";

function RunningNotice({ chats, runs }: RunningWork) {
  if (chats + runs === 0) return null;
  const parts = [
    ...(chats ? [plural(chats, "Chat")] : []),
    ...(runs ? [plural(runs, "Automation run")] : []),
  ];
  return (
    <Alert tone="attention" role="status">
      <AlertTitle>
        {parts.join(" and ")} {chats + runs === 1 ? "is" : "are"} going
      </AlertTitle>
      <AlertDescription>
        {chats + runs === 1 ? "Restarting stops it." : "Restarting stops them."}
        {runs === 1 &&
          " The Automation run is marked as needing attention, so you can run it again."}
        {runs > 1 &&
          " The Automation runs are marked as needing attention, so you can run them again."}
      </AlertDescription>
    </Alert>
  );
}

export function RestartUpdateDialog({
  update,
  beforeInstall,
  onClose,
}: {
  update: UpdateInfo;
  beforeInstall: () => Promise<void>;
  onClose: () => void;
}) {
  const [work, setWork] = useState<RunningWork | null>(null);
  const [failure, setFailure] = useState<ReturnType<
    typeof describeFailure
  > | null>(null);
  const [installing, setInstalling] = useState(false);
  useEffect(() => {
    let active = true;
    void updateClient.restartDetails(update.version).then(
      (running) => {
        if (active) setWork(running);
      },
      (reason: unknown) => {
        if (active) setFailure(describeFailure(reason, "review the restart"));
      },
    );
    return () => {
      active = false;
    };
  }, [update.version]);

  const install = async () => {
    setInstalling(true);
    setFailure(null);
    try {
      await beforeInstall();
      await updateClient.install(update.version);
    } catch (reason) {
      setFailure(describeFailure(reason, "install the update"));
      setInstalling(false);
    }
  };

  return (
    <DialogShell
      open
      onOpenChange={(open) => {
        if (!open && !installing) onClose();
      }}
      title={`Restart to update to ticketd ${update.version}?`}
      description="ticketd closes and opens again. Your workspace, drafts and settings stay as they are."
      size="sm"
      primaryLabel={installing ? "Installing…" : "Restart now"}
      cancelLabel="Not now"
      initialFocus="cancel"
      showClose={false}
      blockedReason={
        work
          ? null
          : failure
            ? "Close and try again."
            : "Checking for running work…"
      }
      busy={installing}
      onSubmit={() => void install()}
      error={failure && <FailureAlert size="compact" failure={failure} />}
    >
      <div className="flex flex-col gap-4">
        {work && <RunningNotice {...work} />}
        {update.upgrades_workspace && (
          <Alert tone="neutral" role="status">
            <AlertTitle>This update upgrades your workspace</AlertTitle>
            <AlertDescription>
              After it, older ticketd on your other Sync devices, and any
              standalone command-line tool, can’t open this workspace until
              they’re updated too. A backup is made first.
            </AlertDescription>
          </Alert>
        )}
      </div>
    </DialogShell>
  );
}
