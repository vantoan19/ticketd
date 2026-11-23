import { useId, useState } from "react";
import { DialogShell } from "@/components/ui/dialog-shell";
import { FailureAlert } from "@/components/ui/failure-alert";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FolderPicker } from "@/features/projects/FolderPicker";
import { useProjectRemoteDetection } from "@/features/projects/use-project-remote-detection";
import { client, type Project } from "@/lib/api/client";
import { toFailure } from "@/lib/api/bridge-failure";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { nameFromFolder } from "@/lib/paths";

type Draft = { name?: string; path?: string; remote?: string };

/** Creates a project from a checkout or edits an existing project's name and remote. */
export function ProjectFormDialog({
  open,
  project,
  initialRemote,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  project?: Project;
  /** An explicit repository selected by the caller takes precedence over detection. */
  initialRemote?: string;
  onOpenChange: (open: boolean) => void;
  onSaved: (project: Project) => void;
}) {
  const nameId = useId();
  const remoteId = useId();
  const remoteErrorId = useId();
  const scope = project?.id ?? "";
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  const [remoteError, setRemoteError] = useState("");
  const [busy, setBusy] = useState(false);
  const draft = drafts[scope];
  const path = project?.path ?? draft?.path ?? "";
  const name = draft?.name ?? project?.name ?? nameFromFolder(path);
  const { detection, pending } = useProjectRemoteDetection(open ? path : "");
  const remote =
    draft?.remote ??
    initialRemote ??
    project?.remote ??
    detection.suggested ??
    "";
  const waiting =
    pending &&
    draft?.remote === undefined &&
    initialRemote === undefined &&
    !project?.remote;

  function edit(change: Draft) {
    setDrafts((old) => ({ ...old, [scope]: { ...old[scope], ...change } }));
    setFailure(null);
    setRemoteError("");
  }

  function close(next: boolean) {
    setFailure(null);
    setRemoteError("");
    onOpenChange(next);
  }

  async function save() {
    setBusy(true);
    setFailure(null);
    setRemoteError("");
    let saved: Project;
    const value = remote.trim();
    try {
      if (project) {
        saved =
          value !== (project.remote ?? "")
            ? await client.editProject(
                project.id,
                name.trim(),
                path,
                value || null,
              )
            : await client.editProject(project.id, name.trim(), path);
      } else {
        saved = value
          ? await client.createProject(name.trim(), path, value)
          : await client.createProject(name.trim(), path);
      }
    } catch (reason) {
      const error = toFailure(reason);
      if (
        error.code === "invalid_project_remote" ||
        error.code === "project_remote_taken"
      )
        setRemoteError(error.message);
      else
        setFailure(
          describeFailure(
            error,
            project ? "save the project" : "create the project",
          ),
        );
      return;
    } finally {
      setBusy(false);
    }
    setDrafts((old) => {
      const next = { ...old };
      delete next[scope];
      return next;
    });
    onOpenChange(false);
    onSaved(saved);
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={close}
      title={project ? "Edit project" : "New project"}
      {...(!project && {
        description: "Start from the repository folder on this computer.",
      })}
      primaryLabel={project ? "Save project" : "Create project"}
      busy={busy}
      blockedReason={
        busy
          ? "Saving…"
          : !project && !path
            ? "Choose a folder to continue."
            : !name.trim()
              ? "Enter a project name."
              : waiting
                ? "Checking the checkout for a Project remote…"
                : null
      }
      error={
        failure && (
          <FailureAlert
            size="compact"
            failure={failure}
            onRetry={() => void save()}
          />
        )
      }
      onSubmit={() => void save()}
    >
      <FieldGroup className="gap-4">
        {!project && (
          <FolderPicker
            label="Repository folder"
            path={path}
            title="Choose the repository folder"
            hint="It becomes the project's first checkout."
            disabled={busy}
            onChoose={(next) => edit({ path: next })}
          />
        )}
        <Field data-disabled={busy || undefined}>
          <FieldLabel htmlFor={nameId}>
            {project ? "Project name" : "Name"}
          </FieldLabel>
          <Input
            id={nameId}
            value={name}
            placeholder="e.g. Desktop app"
            autoComplete="off"
            disabled={busy}
            onChange={(event) => edit({ name: event.target.value })}
          />
        </Field>
        <Field
          data-invalid={Boolean(remoteError) || undefined}
          data-disabled={busy || undefined}
        >
          <FieldLabel htmlFor={remoteId}>Project remote</FieldLabel>
          <Input
            id={remoteId}
            value={remote}
            placeholder="host/owner/name"
            autoComplete="off"
            disabled={busy}
            aria-invalid={Boolean(remoteError) || undefined}
            aria-describedby={remoteError ? remoteErrorId : undefined}
            onChange={(event) => edit({ remote: event.target.value })}
          />
          {remoteError && (
            <FieldError id={remoteErrorId}>{remoteError}</FieldError>
          )}
          {detection.candidates.length > 0 && (
            <Select
              value=""
              disabled={busy}
              onValueChange={(choice) => {
                const candidate = detection.candidates.find(
                  (item) => item.name === choice,
                );
                if (candidate) edit({ remote: candidate.remote });
              }}
            >
              <SelectTrigger aria-label="Checkout remotes">
                <SelectValue placeholder="Choose a checkout remote…" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {detection.candidates.map((candidate) => (
                    <SelectItem key={candidate.name} value={candidate.name}>
                      {candidate.name} · {candidate.remote}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          )}
        </Field>
      </FieldGroup>
    </DialogShell>
  );
}
