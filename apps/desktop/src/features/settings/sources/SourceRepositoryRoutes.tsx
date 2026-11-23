import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { FailureAlert } from "@/components/ui/failure-alert";
import { LinkRepositoryProjectDialog } from "@/features/settings/sources/LinkRepositoryProjectDialog";
import { ProjectFormDialog } from "@/features/projects/ProjectFormDialog";
import { SettingsList } from "@/features/settings/layout/SettingsList";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { sourcesClient, type SourceRepositoryRoute } from "@/lib/api/sources";
import { useWorkspaceChange } from "@/lib/workspace-change";

const title = "Saved repository routes";

export function SourceRepositoryRoutes({
  provider,
  hidden,
  savedKey,
  onProjectLinked,
}: {
  provider: string;
  hidden: boolean;
  savedKey: string;
  onProjectLinked?: (projectId: string) => void;
}) {
  const [routes, setRoutes] = useState<SourceRepositoryRoute[]>([]);
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  const [refresh, setRefresh] = useState(0);
  const version = useWorkspaceChange();
  const [selection, setSelection] = useState<{
    repository: string;
    remote: string;
    step: "choose" | "create";
  } | null>(null);
  const [createExit, setCreateExit] = useState<{ projectId?: string } | null>(
    null,
  );
  const table = useRef<HTMLTableElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const returnFocus = () =>
    opener.current?.isConnected ? opener.current : table.current;

  function linked(projectId: string) {
    close();
    reload();
    onProjectLinked?.(projectId);
  }
  function close() {
    setSelection(null);
    setCreateExit(null);
  }
  function reload() {
    setRefresh((value) => value + 1);
  }
  useEffect(() => {
    if (hidden) return;
    let current = true;
    void sourcesClient.repositoryRoutes(provider).then(
      (loaded) => {
        if (current) {
          setRoutes(loaded);
          setFailure(null);
        }
      },
      (reason) => {
        if (current)
          setFailure(describeFailure(reason, "load saved repository routes"));
      },
    );
    return () => {
      current = false;
    };
  }, [provider, hidden, savedKey, refresh, version]);

  if (!routes.length && !failure) return null;
  return (
    <SettingsSection title={title}>
      {failure ? (
        <FailureAlert size="compact" failure={failure} onRetry={reload} />
      ) : (
        <SettingsList>
          <div className="source-table-scroll">
            <table
              ref={table}
              tabIndex={-1}
              className="source-table"
              aria-label={title}
            >
              <thead>
                <tr>
                  <th scope="col">Repository</th>
                  <th scope="col">Project</th>
                </tr>
              </thead>
              <tbody>
                {routes.map((route) => (
                  <tr key={route.repository}>
                    <th scope="row" className="font-normal break-all">
                      {route.repository}
                    </th>
                    <td>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          {route.project
                            ? `→ ${route.project.name}`
                            : "No project"}
                        </span>
                        {!route.project && route.project_remote && (
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={`Link to project for ${route.repository}`}
                            onClick={(event) => {
                              opener.current = event.currentTarget;
                              if (route.project_remote)
                                setSelection({
                                  repository: route.repository,
                                  remote: route.project_remote,
                                  step: "choose",
                                });
                            }}
                          >
                            Link to project…
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SettingsList>
      )}
      {selection?.step === "choose" && (
        <LinkRepositoryProjectDialog
          provider={provider}
          repository={selection.repository}
          onClose={close}
          onCreate={() => setSelection({ ...selection, step: "create" })}
          onLinked={linked}
          resolveReturnFocus={returnFocus}
        />
      )}
      {selection?.step === "create" && (
        <ProjectFormDialog
          open={createExit === null}
          initialRemote={selection.remote}
          lockRemote
          onOpenChange={(open) => !open && setCreateExit({})}
          onSaved={(project) => setCreateExit({ projectId: project.id })}
          onExitComplete={() => {
            if (createExit?.projectId) linked(createExit.projectId);
            else close();
          }}
          resolveReturnFocus={returnFocus}
        />
      )}
    </SettingsSection>
  );
}
