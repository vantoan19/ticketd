import type { Project } from "@/lib/api/client";

export function projectAssignmentChoices(
  projects: Project[],
  current: string | null,
) {
  const active = projects
    .filter((project) => !project.archived)
    .map((project) => ({ value: project.id, label: project.name }));
  const archived = projects.find(
    (project) => project.archived && project.id === current,
  );
  return archived
    ? [
        ...active,
        { value: archived.id, label: archived.name, group: "Archived" },
      ]
    : active;
}

export function archivedProjectHint(name: string) {
  return `${name} is archived. Reactivate it on the Projects page to link it.`;
}

export function archivedProjectMatch(projects: Project[], query: string) {
  const needle = query.trim().toLowerCase();
  return needle
    ? projects.find(
        (project) =>
          project.archived && project.name.toLowerCase().includes(needle),
      )?.name
    : undefined;
}
