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
import { client, type Project } from "@/lib/api/client";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { useWorkspaceChange } from "@/lib/workspace-change";

type Choices = { projects: Project[] } | { failure: FailureDescription };
type Exit =
  | { action: "cancel" | "create" | "reload" }
  | { action: "link"; projectId: string };

export function LinkRepositoryProjectDialog({
  connection,
  repository,
  onClose,
  onCreate,
  onReloadRoutes,
  onLinked,
  resolveReturnFocus,
}: {
  connection: string;
  repository: string;
  onClose: () => void;
  onCreate: () => void;
  onReloadRoutes: () => void;
  onLinked: (projectId: string) => void;
  resolveReturnFocus: () => HTMLElement | null;
}) {
  const id = useId();
  const version = useWorkspaceChange();
  const [choices, setChoices] = useState<Choices | null>(null);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  const [closing, setClosing] = useState<Exit | null>(null);

  useEffect(() => {
    let current = true;
    void client.listProjects().then(
      (projects) => {
        if (current)
          setChoices({
            projects: projects.filter(
              (project) =>
                !project.archived &&
                !project.remote &&
                project.paths.length > 0,
            ),
          });
      },
      (reason) => {
        if (current)
          setChoices({ failure: describeFailure(reason, "load projects") });
      },
    );
    return () => {
      current = false;
    };
  }, [revision, version]);

  const projects = choices && "projects" in choices ? choices.projects : [];
  const projectId =
    projects.find((project) => project.id === selected)?.id ?? "";
  const loadFailure = choices && "failure" in choices ? choices.failure : null;

  async function link() {
    if (!projectId) return;
    setBusy(true);
    setFailure(null);
    try {
      const project = await client.linkSourceRepositoryProject(
        connection,
        repository,
        projectId,
      );
      setClosing({ action: "link", projectId: project.id });
    } catch (reason) {
      const failed = describeFailure(reason, "link the project");
      setFailure(failed);
      if (
        failed.action === "reload" &&
        failed.code !== "source_repository_not_listed"
      )
        setRevision((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogShell
      open={closing === null}
      onOpenChange={(open) => !open && setClosing({ action: "cancel" })}
      onExitComplete={() => {
        if (closing?.action === "link") onLinked(closing.projectId);
        if (closing?.action === "create") onCreate();
        if (closing?.action === "cancel") onClose();
        if (closing?.action === "reload") onReloadRoutes();
      }}
      resolveReturnFocus={resolveReturnFocus}
      title="Link to project"
      description={`Choose which project receives new issues from ${repository}.`}
      primaryLabel={projects.length ? "Link project" : null}
      footerLeading={
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => setClosing({ action: "create" })}
        >
          Create project…
        </Button>
      }
      busy={busy}
      blockedReason={
        busy
          ? "Linking…"
          : failure?.code === "source_repository_not_listed"
            ? "Choose a saved repository to continue."
            : projects.length && !projectId
              ? "Choose a project."
              : null
      }
      onSubmit={() => void link()}
      error={
        failure ? (
          <FailureAlert
            size="compact"
            failure={failure}
            onRetry={() => void link()}
            actions={
              failure.code === "source_repository_not_listed" && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setClosing({ action: "reload" })}
                >
                  Reload repository routes
                </Button>
              )
            }
          />
        ) : loadFailure ? (
          <FailureAlert
            size="compact"
            failure={loadFailure}
            onRetry={() => setRevision((value) => value + 1)}
          />
        ) : null
      }
    >
      {choices === null && <p role="status">Loading projects…</p>}
      {choices && !loadFailure && !projects.length && (
        <p>No existing projects are available to link.</p>
      )}
      {projects.length > 0 && (
        <FieldGroup>
          <Field data-disabled={busy || undefined}>
            <FieldLabel htmlFor={id}>Project</FieldLabel>
            <Select
              value={projectId}
              onValueChange={(value) => {
                setSelected(value);
                setFailure(null);
              }}
              disabled={busy}
            >
              <SelectTrigger id={id}>
                <SelectValue placeholder="Choose a project…" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </FieldGroup>
      )}
    </DialogShell>
  );
}
