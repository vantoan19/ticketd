import { useContext } from "react";
import { FileText, MessageSquareText, Pencil, X } from "lucide-react";
import { DocumentNavigation } from "@/features/documents/navigation";
import { IconButton } from "@/components/ui/icon-button";
import { FileRow } from "./FileRow";
import type { DocumentLink } from "./use-ticket-documents";

/**
 * A Document in the rail's Files: its title on one line, a caption naming
 * where it comes from ("Linked", "In the description", "In an update"), and
 * one action revealed on hover: Remove, Edit the description, or Go to the
 * update that mentions it.
 */
export function DocumentRow({
  link,
  readOnly,
  onUnlink,
  onOpenUpdate,
  ticketReference,
}: {
  link: DocumentLink;
  readOnly: boolean;
  onUnlink: () => void;
  onOpenUpdate?: ((activityId: string) => void) | undefined;
  ticketReference: string;
}) {
  const openDocument = useContext(DocumentNavigation);
  const origin = link.explicit
    ? "Linked"
    : link.activity_id
      ? "In an update"
      : "In the description";
  const caption = link.target_trashed ? `${origin} · In Trash` : origin;
  function editDescription() {
    window.dispatchEvent(
      new CustomEvent("ticketd:edit-description", {
        detail: { reference: ticketReference, documentId: link.target_id },
      }),
    );
  }
  const action = link.explicit ? (
    readOnly ? null : (
      <IconButton
        label={`Remove ${link.target_label}`}
        tooltipSide="top"
        onClick={onUnlink}
      >
        <X aria-hidden="true" />
      </IconButton>
    )
  ) : link.activity_id ? (
    <IconButton
      label="Go to the update"
      tooltipSide="top"
      onClick={() => onOpenUpdate?.(link.activity_id!)}
    >
      <MessageSquareText aria-hidden="true" />
    </IconButton>
  ) : readOnly ? null : (
    <IconButton
      label={`Edit description to remove ${link.target_label}`}
      tooltipSide="top"
      onClick={editDescription}
    >
      <Pencil aria-hidden="true" />
    </IconButton>
  );
  return (
    <FileRow
      icon={<FileText aria-hidden="true" />}
      name={link.target_label}
      caption={caption}
      onOpen={() => openDocument?.(link.target_id)}
      action={action}
    />
  );
}
