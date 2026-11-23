import { useEffect, useEffectEvent, useState } from "react";
import { DialogShell } from "@/components/ui/dialog-shell";
import { FailureAlert } from "@/components/ui/failure-alert";
import { toFailure } from "@/lib/api/bridge-failure";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import {
  sourcesClient,
  type ConnectSourceMatchCount,
  type ConnectSourcePreview,
} from "@/lib/api/sources";
import { plural } from "@/lib/format";

export type ProjectSourceSetup = {
  provider: string;
  repository: string;
  projectId: string;
};

type PreviewState =
  | { status: "loading" }
  | { status: "failed"; failure: FailureDescription }
  | { status: "ready"; preview: ConnectSourcePreview };

const PROVIDER = "github";

/** Review the exact effect, with a separate live count when adding discovery. */
export function ConnectProjectSource({
  projectId,
  onClose,
  onSetup,
  onConnected,
  resumeAfterSetup = false,
}: {
  projectId: string;
  onClose: () => void;
  onSetup: (setup: ProjectSourceSetup) => void;
  onConnected: () => void;
  /** A newly saved source only needs another dialog if there is something to review. */
  resumeAfterSetup?: boolean;
}) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<PreviewState>({ status: "loading" });
  const [count, setCount] = useState<
    ConnectSourceMatchCount | null | undefined
  >();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  const [changed, setChanged] = useState(false);
  const closeEmpty = useEffectEvent(onClose);
  useEffect(() => {
    let current = true;
    void sourcesClient.previewConnectSource(PROVIDER, projectId).then(
      (preview) => {
        if (!current) return;
        if (
          resumeAfterSetup &&
          preview.source === "already_listed" &&
          !preview.tickets.length
        ) {
          closeEmpty();
          return;
        }
        setState({ status: "ready", preview });
        if (preview.source === "add_repository") {
          void sourcesClient
            .connectSourceMatchCount(PROVIDER, projectId, preview.fingerprint)
            .then(
              (result) => {
                if (current) setCount(result);
              },
              () => {
                if (current) setCount(null);
              },
            );
        }
      },
      (reason) => {
        if (current)
          setState({
            status: "failed",
            failure: describeFailure(reason, "preview source setup"),
          });
      },
    );
    return () => {
      current = false;
    };
  }, [projectId, resumeAfterSetup, revision]);

  function reload() {
    setState({ status: "loading" });
    setCount(undefined);
    setRevision((previous) => previous + 1);
  }

  const preview = state.status === "ready" ? state.preview : null;
  const needsSetup = preview?.source === "not_connected";
  const addsRepository = preview?.source === "add_repository";
  const linkCount = preview?.tickets.length ?? 0;
  const hasEffect = needsSetup || addsRepository || linkCount > 0;
  const error = state.status === "failed" ? state.failure : failure;

  async function confirm() {
    if (!preview) return;
    if (preview.source === "not_connected") {
      onSetup({
        provider: preview.provider,
        repository: preview.repository,
        projectId,
      });
      return;
    }
    setBusy(true);
    setChanged(false);
    setFailure(null);
    try {
      await sourcesClient.connectSource(
        preview.provider,
        projectId,
        preview.fingerprint,
      );
    } catch (reason) {
      const error = toFailure(reason);
      if (error.code === "conflict") {
        setChanged(true);
        reload();
      } else {
        setFailure(describeFailure(error, "connect the project to GitHub"));
      }
      return;
    } finally {
      setBusy(false);
    }
    onConnected();
    onClose();
  }

  return (
    <DialogShell
      open
      onOpenChange={(open) => !open && onClose()}
      title="Connect project to GitHub"
      primaryLabel={
        hasEffect ? (needsSetup ? "Set up GitHub" : "Confirm") : null
      }
      cancelLabel="Skip"
      busy={busy}
      blockedReason={
        busy
          ? "Connecting…"
          : addsRepository && count === undefined
            ? "Counting matching issues…"
            : null
      }
      onSubmit={() => void confirm()}
      error={
        error ? (
          <FailureAlert
            size="compact"
            failure={error}
            onRetry={state.status === "failed" ? reload : () => void confirm()}
          />
        ) : changed && state.status === "ready" ? (
          "The preview changed. Review the updated changes before confirming."
        ) : null
      }
    >
      {state.status === "loading" && (
        <p role="status">Checking source setup…</p>
      )}
      {preview && (
        <>
          {needsSetup && (
            <p>
              Connect GitHub with {preview.repository} to import its issues.
            </p>
          )}
          {addsRepository && (
            <p role="status">
              Import issues from {preview.project_remote}
              {count === undefined
                ? ""
                : count
                  ? ` (${count.complete ? "" : "at least "}${count.matched} match)`
                  : " (match count unavailable)"}
            </p>
          )}
          {(!needsSetup || linkCount > 0) && (
            <p>
              {linkCount
                ? `Link ${plural(linkCount, "existing ticket")}`
                : "No existing tickets to link."}
            </p>
          )}
        </>
      )}
    </DialogShell>
  );
}
