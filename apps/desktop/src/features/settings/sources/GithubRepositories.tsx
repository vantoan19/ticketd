import { useId, useRef, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DialogShell } from "@/components/ui/dialog-shell";
import {
  SettingsList,
  SettingsListFooter,
  SettingsRow,
} from "@/features/settings/layout/SettingsList";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import { GithubRepositoryEditor } from "@/features/settings/sources/GithubRepositoryEditor";
import {
  lastGithubRefresh,
  repositoryName,
} from "@/features/settings/sources/github-repositories";
import { plural } from "@/features/settings/sources/source-rows";
import { failureText } from "@/lib/api/describe-failure";
import { sourcesClient } from "@/lib/api/sources";
import { relativeDateTime } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import {
  removeGithubRepository,
  type GithubIntegration,
  type GithubRepository,
} from "@/lib/api/github";
import "./github-repositories.css";

export function GithubRepositories({
  integration,
  onChanged,
  projectSetup,
}: {
  integration: GithubIntegration;
  onChanged: () => void;
  projectSetup?: {
    repository: string;
    onSaved: () => void;
    onCancel: () => void;
  };
}) {
  const { repositories, hosts, migration_notices: notices } = integration;
  const [adding, setAdding] = useState(false);
  const projectHost =
    projectSetup?.repository.split("/").length === 3
      ? projectSetup.repository.split("/")[0]?.toLowerCase()
      : "github.com";
  const projectHostState = hosts.find(
    ({ host }) => host === projectHost,
  )?.state;
  const addingForProject =
    !!projectSetup && (!projectHostState || projectHostState === "connected");
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<GithubRepository | null>(null);
  const add = useRef<HTMLButtonElement>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const now = useNow();
  const last = lastGithubRefresh(repositories);

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError("");
    try {
      const { failures } = await sourcesClient.refresh(undefined, "github");
      if (failures.length > 0)
        setRefreshError(
          failures[0]?.message || "Some GitHub issues could not be refreshed.",
        );
    } catch (reason) {
      setRefreshError(failureText(reason, "refresh GitHub"));
    } finally {
      setRefreshing(false);
      onChanged();
    }
  }

  return (
    <SettingsSection
      title="Repositories"
      className="github-repositories"
      caption={
        last
          ? `Refreshed ${relativeDateTime(last, now)}, then every 5 minutes while ticketd is open.`
          : "Refreshes every 5 minutes while ticketd is open."
      }
      actions={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={refreshing || !repositories.length}
          onClick={() => void refresh()}
        >
          <RefreshCw data-icon="inline-start" />
          {refreshing ? "Refreshing…" : "Refresh now"}
        </Button>
      }
      focusTarget
    >
      {refreshError && (
        <Alert tone="error" size="compact" className="mb-3">
          <AlertDescription>{refreshError}</AlertDescription>
        </Alert>
      )}
      <SettingsList>
        {repositories.map((repository) => {
          const host = hosts.find(({ host }) =>
            repository.repository
              .toLowerCase()
              .startsWith(`${host.toLowerCase()}/`),
          );
          return (
            <RepositoryRow
              key={repository.repository}
              repository={repository}
              activeLogin={repository.project_login ?? host?.login}
              editing={editing === repository.repository}
              now={now}
              onToggle={() =>
                setEditing(
                  editing === repository.repository
                    ? null
                    : repository.repository,
                )
              }
              onSaved={() => {
                setEditing((current) =>
                  current === repository.repository ? null : current,
                );
                onChanged();
              }}
              onRemove={() => setRemoving(repository)}
            />
          );
        })}
        {notices.map(({ repository, message }) => (
          <SettingsRow
            key={`${repository}:${message}`}
            title={repositoryName(repository)}
            description={message}
          />
        ))}
        <SettingsRow
          tight
          leading={
            <span className="github-add-icon">
              <Plus size={16} aria-hidden="true" />
            </span>
          }
          title={
            <button
              ref={add}
              type="button"
              className="github-row-action"
              disabled={!!projectSetup && !addingForProject}
              onClick={() => setAdding(true)}
            >
              Add a repository
            </button>
          }
        />
        <SettingsListFooter>
          Pull requests aren’t brought in.
        </SettingsListFooter>
      </SettingsList>
      {projectSetup && !addingForProject && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-3"
          onClick={projectSetup.onCancel}
        >
          Return to project
        </Button>
      )}
      {(adding || addingForProject) && (
        <GithubRepositoryEditor
          knownRepositories={repositories}
          {...(projectSetup && { initialRepository: projectSetup.repository })}
          onCancel={() => {
            setAdding(false);
            projectSetup?.onCancel();
          }}
          onSaved={() => {
            setAdding(false);
            onChanged();
            projectSetup?.onSaved();
          }}
          returnFocus={add}
        />
      )}
      {removing && (
        <RemoveRepository
          repository={removing}
          onCancel={() => setRemoving(null)}
          onRemoved={() => {
            if (editing === removing.repository) setEditing(null);
            setRemoving(null);
            onChanged();
          }}
          returnFocus={add}
        />
      )}
    </SettingsSection>
  );
}

function RepositoryRow({
  repository,
  activeLogin,
  editing,
  now,
  onToggle,
  onSaved,
  onRemove,
}: {
  repository: GithubRepository;
  activeLogin: string | null | undefined;
  editing: boolean;
  now: number;
  onToggle: () => void;
  onSaved: () => void;
  onRemove: () => void;
}) {
  const id = useId();
  const [saving, setSaving] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const closeEditor = (action: () => void) => {
    action();
    toggle.current?.focus();
  };
  const name = repositoryName(repository.repository);
  return (
    <>
      <SettingsRow
        title={
          <button
            ref={toggle}
            type="button"
            className="github-row-action"
            aria-controls={editing ? id : undefined}
            aria-expanded={editing}
            aria-disabled={saving || undefined}
            onClick={saving ? undefined : onToggle}
          >
            {name}
          </button>
        }
        description={`${issueFilter(repository, activeLogin)} → ${repository.project?.name ?? "No project"} · ${repository.tracked_tickets} ${plural("ticket", repository.tracked_tickets)}`}
        trailing={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Remove ${name}`}
            disabled={saving}
            onClick={onRemove}
          >
            Remove…
          </Button>
        }
      />
      {editing && (
        <div className="github-repository-editor" id={id}>
          {repository.project_login && (
            <p className="settings-list-row-description">
              Project login for {repository.repository.split("/")[0]} is pinned
              to {repository.project_login}.
            </p>
          )}
          <p className="settings-list-row-description">
            {repository.last_refreshed_at
              ? `Refreshed ${relativeDateTime(repository.last_refreshed_at, now)}`
              : "Not refreshed yet"}
          </p>
          {repository.error && (
            <Alert tone="error" size="compact">
              <AlertDescription>{repository.error.message}</AlertDescription>
            </Alert>
          )}
          <GithubRepositoryEditor
            repository={repository}
            knownRepositories={[]}
            returnFocus={toggle}
            onSavingChange={setSaving}
            onCancel={() => closeEditor(onToggle)}
            onSaved={() => closeEditor(onSaved)}
          />
        </div>
      )}
    </>
  );
}

function issueFilter(
  { assignee, labels }: GithubRepository,
  activeLogin: string | null | undefined,
) {
  const who = assignee
    ? assignee === "@me" ||
      assignee.toLowerCase() === activeLogin?.toLowerCase()
      ? "you"
      : assignee
    : "";
  if (!who && labels.length === 0) return "All open issues";
  return `Open issues${who ? ` assigned to ${who}` : ""}${labels.length > 0 ? ` labeled ${labels.join(", ")}` : ""}`;
}

function RemoveRepository({
  repository,
  onCancel,
  onRemoved,
  returnFocus,
}: {
  repository: GithubRepository;
  onCancel: () => void;
  onRemoved: () => void;
  returnFocus: React.RefObject<HTMLButtonElement | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const removed = useRef(false);
  const count = repository.tracked_tickets;
  const name = repositoryName(repository.repository);
  async function remove() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await removeGithubRepository(repository.repository);
      removed.current = true;
      onRemoved();
    } catch (reason) {
      setError(failureText(reason, "remove the repository"));
      setBusy(false);
    }
  }
  return (
    <DialogShell
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={`Stop bringing in ${name}?`}
      description={
        count === 1
          ? "Its ticket keeps its last synced content and your work."
          : `Its ${count} tickets keep their last synced content and your work.`
      }
      size="sm"
      primaryLabel={busy ? "Removing…" : "Remove"}
      primaryVariant="destructive"
      blockedReason={busy ? "Removing this repository…" : null}
      onSubmit={() => void remove()}
      busy={busy}
      error={error}
      resolveReturnFocus={() => (removed.current ? returnFocus.current : null)}
    />
  );
}
