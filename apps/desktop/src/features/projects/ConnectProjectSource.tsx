import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import { FailureAlert } from "@/components/ui/failure-alert";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSourceActivity } from "@/features/tickets/source-activity";
import { toFailure } from "@/lib/api/bridge-failure";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import {
  sourcesClient,
  type ConnectSourceMatchCount,
  type ConnectSourcePreview,
  type ProjectSourceCandidate,
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

type Choices =
  { candidates: ProjectSourceCandidate[] } | { failure: FailureDescription };

type ReviewProps = {
  projectId: string;
  projectRemote?: string;
  connection?: string;
  onClose: () => void;
  closing?: boolean;
  onSetup: (setup: ProjectSourceSetup) => void;
  onConnected: () => void;
  onEditRemote?: () => void;
  fallbackFocus?: () => HTMLElement | null;
  /** A newly saved source only needs another dialog if there is something to review. */
  resumeAfterSetup?: boolean;
};

export function ConnectProjectSource(props: ReviewProps) {
  return (
    <ProjectSourceReview
      key={JSON.stringify([props.projectId, props.connection])}
      {...props}
    />
  );
}

/** Review the exact effect, with a separate live count when adding discovery. */
function ProjectSourceReview({
  projectId,
  projectRemote,
  connection,
  onClose,
  closing = false,
  onSetup,
  onConnected,
  onEditRemote,
  fallbackFocus,
  resumeAfterSetup = false,
}: ReviewProps) {
  const fieldId = useId();
  const entries = useSourceActivity().entries;
  const [opener] = useState(() => document.activeElement);
  const [exit, setExit] = useState<Exit | null>(null);
  const [revision, setRevision] = useState(0);
  const [choices, setChoices] = useState<Choices | null>(null);
  const [selected, setSelected] = useState("");
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
    void sourcesClient.projectSourceCandidates(projectId).then(
      (candidates) => {
        if (current) setChoices({ candidates });
      },
      (reason) => {
        if (current)
          setChoices({
            failure: describeFailure(reason, "load source connections"),
          });
      },
    );
    return () => {
      current = false;
    };
  }, [projectId, revision]);
  const candidates =
    choices && "candidates" in choices ? choices.candidates : [];
  const candidate = connection
    ? candidates.find(({ source }) => source === connection)
    : selected
      ? candidates.find(({ source }) => source === selected)
      : candidates.length === 1
        ? candidates[0]
        : undefined;
  const showPicker =
    !connection &&
    (candidates.length > 1 || (candidates.length === 1 && !candidate));
  const source = candidate?.source;
  const sourceName =
    entries?.find(({ connector }) => connector.provider === candidate?.provider)
      ?.connector.name ?? candidate?.name;
  useEffect(() => {
    if (!source) return;
    let current = true;
    void sourcesClient.previewConnectSource(source, projectId).then(
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
  }, [projectId, resumeAfterSetup, source]);

  const preview = state.status === "ready" ? state.preview : null;
  const githubSetup =
    preview?.provider === "github" &&
    preview.connection_id === null &&
    preview.source === "add_repository";
  const needsSetup = githubSetup || preview?.source === "not_connected";
  const addsRepository = !githubSetup && preview?.source === "add_repository";
  const fingerprint = addsRepository ? preview.fingerprint : null;
  const matchCount = count?.fingerprint === fingerprint ? count : null;
  useEffect(() => {
    if (!fingerprint || !source || exit) return;
    let current = true;
    void sourcesClient
      .connectSourceMatchCount(source, projectId, fingerprint)
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
  }, [projectId, source, fingerprint, countRevision, exit]);

  function resetPreview() {
    setState({ status: "loading" });
    setCount(null);
    setFailure(null);
  }

  function reload() {
    resetPreview();
    setChoices(null);
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
  const error =
    choices && "failure" in choices
      ? choices.failure
      : state.status === "failed"
        ? state.failure
        : failure;
  const unavailable =
    choices &&
    "candidates" in choices &&
    (candidates.length === 0 || (connection && !candidate));
  const countFailure = matchCount?.failure;

  async function confirm() {
    if (!preview || !source) return;
    if (needsSetup) {
      setExit({
        action: "setup",
        setup: {
          provider: preview.provider,
          repository:
            preview.provider === "github"
              ? preview.project_remote
              : preview.repository,
          projectId,
        },
      });
      return;
    }
    setBusy(true);
    setChanged(false);
    setFailure(null);
    try {
      await sourcesClient.connectSource(source, projectId, preview.fingerprint);
      setExit({ action: "connected" });
    } catch (reason) {
      const error = toFailure(reason);
      if (error.code === "conflict") {
        setChanged(true);
        reload();
      } else {
        setFailure(describeFailure(error, "connect the project to the source"));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogShell
      open={!closing && exit === null}
      onOpenChange={(open) => !open && setExit({ action: "skip" })}
      onExitComplete={() => {
        if (closing) onClose();
        else if (exit?.action === "setup") onSetup(exit.setup);
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
      title={
        sourceName
          ? `Connect project to ${sourceName}`
          : "Connect project to a source"
      }
      primaryLabel={
        hasEffect
          ? needsSetup
            ? githubSetup
              ? "Add repository…"
              : `Set up ${sourceName ?? "source"}`
            : "Confirm"
          : null
      }
      cancelLabel={
        unavailable || error?.code === "project_source_host_mismatch"
          ? "Close"
          : "Skip"
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
            onRetry={failure ? () => void confirm() : reload}
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
      {showPicker && (
        <FieldGroup>
          <Field data-disabled={busy || undefined}>
            <FieldLabel htmlFor={fieldId}>Source connection</FieldLabel>
            <Select
              value={candidate?.source ?? ""}
              onValueChange={(value) => {
                resetPreview();
                setChanged(false);
                setSelected(value);
              }}
              disabled={busy}
            >
              <SelectTrigger id={fieldId}>
                <SelectValue placeholder="Choose a source connection…" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {candidates.map(({ source, name }) => (
                    <SelectItem key={source} value={source}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </FieldGroup>
      )}
      {candidate?.connection_id && !showPicker && (
        <p>Source connection {candidate.name}</p>
      )}
      {unavailable && (
        <p>
          {connection
            ? `This source connection is unavailable for ${projectRemote ?? "the Project remote"}.`
            : `No source connection matches ${projectRemote ?? "this Project remote"}.`}{" "}
          {onEditRemote && (
            <Button
              type="button"
              variant="link"
              size="inline"
              onClick={() => setExit({ action: "edit" })}
            >
              Edit Project remote
            </Button>
          )}
        </p>
      )}
      {(!choices || (candidate && state.status === "loading")) && (
        <p role="status">Checking source setup…</p>
      )}
      {preview && (
        <>
          {needsSetup && (
            <p>
              {githubSetup
                ? `Choose which issues from ${preview.project_remote} to bring in.`
                : `Connect ${sourceName} with ${preview.repository} to import its issues.`}
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
