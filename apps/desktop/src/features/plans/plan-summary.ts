import type { Project } from "@/lib/api/client";
import type { View } from "@/lib/api/plans";

/** "N tickets · projects · N blocked" for a Plan's members. */
export function planSummary(
  members: View["members"],
  projects: Project[],
): string {
  const names = [
    ...new Set(
      members.map(
        (member) =>
          projects.find((item) => item.id === member.project_id)?.name ??
          "no project",
      ),
    ),
  ];
  const blocked = members.filter(
    (member) => member.availability === "Blocked",
  ).length;
  return [
    `${members.length} ${members.length === 1 ? "ticket" : "tickets"}`,
    names.length > 0 ? names.join(", ") : null,
    blocked > 0 ? `${blocked} blocked` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
