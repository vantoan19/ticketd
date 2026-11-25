import { useEffect, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { PathText } from "@/components/ui/path-text";
import { useChatClient, type ProjectFolder } from "@/features/chats/client";
import { withoutVerbatim } from "@/lib/paths";

export const SCRATCH_FOLDER = "Scratch folder";

function FolderOption({
  name,
  detail,
  current,
}: {
  name: string;
  detail: ReactNode;
  current: boolean;
}) {
  return (
    <span className="chat-folder-option">
      <span className="chat-folder-option-line">
        <span>{name}</span>
        {current && <Check aria-hidden />}
      </span>
      {detail}
    </span>
  );
}

/** Shared by New Chat and the action for replacing a missing folder. */
export function ChatFolderChoices({
  draft,
  unavailableFolder,
  onPick,
  onBrowseError,
}: {
  draft?: {
    folder: string | null;
    recent: string[];
    onScratch: () => void;
  };
  unavailableFolder?: string;
  onPick: (path: string) => void;
  onBrowseError: (reason: unknown) => void;
}) {
  const client = useChatClient();
  const [projects, setProjects] = useState<ProjectFolder[] | "failed" | null>(
    null,
  );
  useEffect(() => {
    let current = true;
    void client.listProjectFolders().then(
      (folders) => current && setProjects(folders),
      () => current && setProjects("failed"),
    );
    return () => {
      current = false;
    };
  }, [client]);

  const unavailable = unavailableFolder && withoutVerbatim(unavailableFolder);
  const projectFolders = Array.isArray(projects)
    ? projects.filter(({ path }) => withoutVerbatim(path) !== unavailable)
    : [];
  const selected = draft?.folder ? withoutVerbatim(draft.folder) : null;
  const recentPaths = draft
    ? [...new Set([...(draft.folder ? [draft.folder] : []), ...draft.recent])]
    : [];

  return (
    <>
      {draft && (
        <>
          {recentPaths.map((path) => {
            const shown = withoutVerbatim(path);
            const name = shown.split(/[\\/]/).filter(Boolean).at(-1) ?? shown;
            const parent = shown
              .slice(0, shown.lastIndexOf(name))
              .replace(/[\\/]$/, "");
            return (
              <DropdownMenuItem
                key={path}
                aria-current={shown === selected || undefined}
                onSelect={() => onPick(path)}
              >
                <FolderOption
                  name={name}
                  detail={<small>{parent || shown}</small>}
                  current={shown === selected}
                />
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuItem
            aria-current={selected === null || undefined}
            onSelect={draft.onScratch}
          >
            <FolderOption
              name={SCRATCH_FOLDER}
              detail={<small>A new empty folder kept by ticketd</small>}
              current={selected === null}
            />
          </DropdownMenuItem>
          <DropdownMenuSeparator />
        </>
      )}
      <DropdownMenuItem
        onSelect={() =>
          void client
            .pickFolder()
            .then((path) => path && onPick(path), onBrowseError)
        }
      >
        Choose a folder…
      </DropdownMenuItem>
      {projectFolders.length > 0 ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuGroup aria-label="Project folders">
            <DropdownMenuLabel>Project folders</DropdownMenuLabel>
            {projectFolders.map(({ project, path }) => {
              const shown = withoutVerbatim(path);
              return (
                <DropdownMenuItem
                  key={JSON.stringify([project.id, path])}
                  aria-label={`${project.title} ${shown}`}
                  aria-current={shown === selected || undefined}
                  textValue={project.title}
                  onSelect={() => onPick(path)}
                >
                  <FolderOption
                    name={project.title}
                    detail={<PathText path={path} layout="folder" />}
                    current={shown === selected}
                  />
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>
        </>
      ) : projects === null ? (
        <DropdownMenuLabel>Loading project folders…</DropdownMenuLabel>
      ) : projects === "failed" ? (
        <DropdownMenuLabel>Couldn’t load project folders</DropdownMenuLabel>
      ) : !draft ? (
        <DropdownMenuLabel>No other project folders</DropdownMenuLabel>
      ) : null}
    </>
  );
}
