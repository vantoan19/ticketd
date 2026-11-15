import type { AttachmentUsage } from "@/lib/api/attachments";

const places: Record<string, string> = {
  ticket_attachment: "Attached to a ticket",
  ticket_body: "In a ticket description",
  document_body: "In a Document",
  activity_brief: "In an update",
  draft: "In an unsaved draft",
  undo: "Kept for Undo",
};

/** Where a file is used, in plain words: "In a Document · in Trash; Kept for Undo". */
export function usageContext(usage: AttachmentUsage) {
  const reasons = usage.protections.map(
    (use) =>
      `${places[use.kind] ?? use.kind}${use.trashed ? " · in Trash" : ""}`,
  );
  return [...new Set(reasons)].join("; ") || "Unused";
}
