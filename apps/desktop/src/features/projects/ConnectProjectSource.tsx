import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
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

type Exit =
  | { action: "skip" | "connected" | "edit" }
  | { action: "setup"; setup: ProjectSourceSetup };

const PROVIDER = "github";

type ReviewProps = {
  projectId: string;
  onClose: () => void;
  onSetup: (setup: ProjectSourceSetup) => void;
  onConnected: () => void;
  onEditRemote?: () => void;
  fallbackFocus?: () => HTMLElement | null;
  /** A newly saved source only needs another dialog if there is something to review. */
  resumeAfterSetup?: boolean;
};

export function ConnectProjectSource(props: ReviewProps) {
  return <ProjectSourceReview key={props.projectId} {...props} />;
}

/** Review the exact effect, with a separate live count when adding discovery. */
function ProjectSourceReview({
  projectId,
  onClose,
  onSetup,
  onConnected,
  onEditRemote,
  fallbackFocus,
  resumeAfterSetup = false,
}: ReviewProps) {
  const [opener] = useState(() => document.activeElement);
  const [exit, setExit] = useState<Exit | null>(null);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<PreviewState>({ status: "loading" });
  const [countRevision, setCountRevision] = useState(0);
  const [count, setCount] = useState<{
    fingerprint: string;
    result: ConnectSourceMatchCount | null;
    failure: FailureDescription | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  const [changed, setChanged] = useState(false);
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
          setExit({ action: "skip" });
          return;
        }
        setState({ status: "ready", preview });
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

  const preview = state.status === "ready" ? state.preview : null;
  const needsSetup = preview?.source === "not_connected";
  const addsRepository = preview?.source === "add_repository";
  const fingerprint = addsRepository ? preview.fingerprint : null;
  const matchCount = count?.fingerprint === fingerprint ? count : null;
  useEffect(() => {
    if (!fingerprint || exit) return;
    let current = true;
    void sourcesClient
      .connectSourceMatchCount(PROVIDER, projectId, fingerprint)
      .then(
        (result) => {
          if (current) setCount({ fingerprint, result, failure: null });
        },
        (reason) => {
          if (current)
            setCount({
              fingerprint,
              result: null,
              failure: describeFailure(reason, "count matching issues"),
            });
        },
      );
    return () => {
      current = false;
    };
  }, [projectId, fingerprint, countRevision, exit]);

  function reload() {
    setState({ status: "loading" });
    setCount(null);
    setRevision((previous) => previous + 1);
  }

  function retryCount() {
    if (matchCount?.failure?.action === "reload") {
      setChanged(true);
      reload();
    } else {
      setCount(null);
      setCountRevision((previous) => previous + 1);
    }
  }

  const linkCount = preview?.tickets.length ?? 0;
  const hasEffect = needsSetup || addsRepository || linkCount > 0;
  const error = state.status === "failed" ? state.failure : failure;
  const countFailure = matchCount?.failure;

  async function confirm() {
    if (!preview) return;
    if (preview.source === "not_connected") {
      setExit({
        action: "setup",
        setup: {
          provider: preview.provider,
          repository: preview.repository,
          projectId,
        },
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
      setExit({ action: "connected" });
    } catch (reason) {
      const error = toFailure(reason);
      if (error.code === "conflict") {
        setChanged(true);
        reload();
      } else {
        setFailure(describeFailure(error, "connect the project to GitHub"));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogShell
      open={exit === null}
      onOpenChange={(open) => !open && setExit({ action: "skip" })}
      onExitComplete={() => {
        if (exit?.action === "setup") onSetup(exit.setup);
        else if (exit?.action === "edit") onEditRemote?.();
        else {
          if (exit?.action === "connected") onConnected();
          onClose();
        }
      }}
      resolveReturnFocus={() =>
        opener instanceof HTMLElement &&
        opener !== document.body &&
        opener.isConnected &&
        !opener.closest("[hidden], [inert]")
          ? opener
          : (fallbackFocus?.() ?? null)
      }
      title="Connect project to GitHub"
      primaryLabel={
        hasEffect ? (needsSetup ? "Set up GitHub" : "Confirm") : null
      }
      cancelLabel={
        error?.code === "project_source_host_mismatch" ? "Close" : "Skip"
      }
      busy={busy}
      blockedReason={
        busy
          ? "Connecting…"
          : addsRepository && matchCount === null
            ? "Counting matching issues…"
            : countFailure?.action === "reload"
              ? "Review the updated changes before confirming."
              : null
      }
      onSubmit={() => void confirm()}
      error={
        error ? (
          <FailureAlert
            size="compact"
            failure={error}
            onRetry={state.status === "failed" ? reload : () => void confirm()}
            actions={
              error.code === "project_source_host_mismatch" &&
              onEditRemote && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setExit({ action: "edit" })}
                >
                  Edit Project remote
                </Button>
              )
            }
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
              {matchCount?.result
                ? ` (${matchCount.result.complete ? "" : "at least "}${matchCount.result.matched} match)`
                : ""}
            </p>
          )}
          {countFailure && (
            <FailureAlert
              size="compact"
              failure={countFailure}
              onRetry={retryCount}
              actions={
                countFailure.action === "reload" && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={retryCount}
                  >
                    Review updated changes
                  </Button>
                )
              }
            />
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
