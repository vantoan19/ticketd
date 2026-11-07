import type { AttachmentUsage } from "@/lib/api/attachments";

export function usageContext(usage: AttachmentUsage) {
  const labels: Record<string, string> = {
    ticket_attachment: "Direct attachment",
    ticket_body: "Ticket description",
    document_body: "Document · not a direct ticket attachment",
    activity_brief: "Update brief",
    draft: "Recoverable draft",
    undo: "Recoverable Undo",
  };
  const reasons = usage.protections.map(
    (use) =>
      `${labels[use.kind] ?? use.kind}${use.trashed ? " · in Trash" : ""}`,
  );
  return [...new Set(reasons)].join("; ") || "Not used yet";
}
