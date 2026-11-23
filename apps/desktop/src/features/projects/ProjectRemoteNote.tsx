import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { ProjectFormDialog } from "@/features/projects/ProjectFormDialog";
import { useProjectRemoteDetection } from "@/features/projects/use-project-remote-detection";
import { toFailure } from "@/lib/api/bridge-failure";
import type { Project } from "@/lib/api/client";
import { sourcesClient } from "@/lib/api/sources";
import { useWorkspaceChange } from "@/lib/workspace-change";

/** The project's header offers setup after Skip, or a remote for a legacy project. */
export function ProjectRemoteNote({
  project,
  sourceRevision,
  onConnectSource,
  onProjectChange,
}: {
  project: Project | undefined;
  sourceRevision: string;
  onConnectSource: (projectId: string) => void;
  onProjectChange: () => void;
}) {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [editing, setEditing] = useState(false);
  const [savedProject, setSavedProject] = useState<Project | null>(null);
  const version = useWorkspaceChange();
  const [source, setSource] = useState<{
    key: string;
    action: "setup" | "backfill" | "none";
  } | null>(null);
  const { detection } = useProjectRemoteDetection(
    project && !project.remote ? project.path : "",
  );
  const { suggested, candidates } = detection;
  const projectId = project?.id;
  const remote = project?.remote;
  const key = remote ? JSON.stringify([projectId, remote]) : "";
  useEffect(() => {
    if (!projectId || !key) return;
    let current = true;
    void sourcesClient.previewConnectSource("github", projectId).then(
      (preview) => {
        if (current)
          setSource({
            key,
            action:
              preview.source !== "already_listed"
                ? "setup"
                : preview.tickets.length
                  ? "backfill"
                  : "none",
          });
      },
      (reason) => {
        if (current)
          setSource({
            key,
            action:
              toFailure(reason).code === "project_source_host_mismatch"
                ? "setup"
                : "none",
          });
      },
    );
    return () => {
      current = false;
    };
  }, [key, projectId, sourceRevision, version]);
  if (!project) return null;

  const legacy = !remote && (suggested !== null || candidates.length > 0);
  const action = key !== "" && source?.key === key ? source.action : "none";
  const noticeKey = legacy
    ? JSON.stringify([projectId, suggested, candidates])
    : JSON.stringify([key, action]);
  const show = (legacy || action !== "none") && !dismissed.has(noticeKey);
  return (
    <>
      {show && (
        <Alert role="status" size="compact" className="mx-4 my-2">
          <AlertDescription>
            {legacy
              ? suggested
                ? `Detected ${suggested}.`
                : "Detected checkout remotes."
              : action === "backfill"
                ? "Existing GitHub tickets can be linked to this project."
                : "Issues from this repository aren't being imported."}{" "}
            <Button
              type="button"
              variant="link"
              size="inline"
              onClick={(event) => {
                event.currentTarget.focus();
                if (legacy) setEditing(true);
                else onConnectSource(project.id);
              }}
            >
              {legacy
                ? "Set as remote?"
                : action === "backfill"
                  ? "Review links"
                  : "Set up"}
            </Button>
          </AlertDescription>
          <IconButton
            label="Dismiss Project remote note"
            onClick={() => setDismissed((old) => new Set(old).add(noticeKey))}
          >
            <X />
          </IconButton>
        </Alert>
      )}
      {legacy && (
        <ProjectFormDialog
          key={project.id}
          open={editing}
          project={project}
          {...(suggested && { initialRemote: suggested })}
          onOpenChange={setEditing}
          onSaved={setSavedProject}
          onExitComplete={() => {
            if (!savedProject) return;
            setSavedProject(null);
            onProjectChange();
            if (savedProject.remote) onConnectSource(savedProject.id);
          }}
        />
      )}
    </>
  );
}
