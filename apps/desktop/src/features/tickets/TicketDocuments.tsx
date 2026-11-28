import { useContext } from "react";
import { FileText, MessageSquareText, Pencil, X } from "lucide-react";
import { DocumentNavigation } from "@/features/documents/navigation";
import { IconButton } from "@/components/ui/icon-button";
import { FileCard } from "@/features/attachments/FileCard";
import { useNearViewport } from "@/features/attachments/use-near-viewport";
import { DocumentPage } from "./DocumentPage";
import type { DocumentLink } from "@/features/documents/api";

/**
 * A Document in the rail's Files: the same card as a file, its title for the
 * name, its first page as paper in the frame and a caption naming where it comes from ("Document · Linked", "Document ·
 * In the description"), with one action revealed on hover: Remove, Edit the
 * description, or Go to the update that mentions it.
 */
export function DocumentRow({
  link,
  readOnly,
  onUnlink,
  onOpenUpdate,
  ticketReference,
  cardWidth,
}: {
  link: DocumentLink;
  readOnly: boolean;
  onUnlink: () => void;
  onOpenUpdate?: ((activityId: string) => void) | undefined;
  ticketReference: string;
  cardWidth: number;
}) {
  const openDocument = useContext(DocumentNavigation);
  const [ref, near] = useNearViewport<HTMLDivElement>();
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
    <li className="file-card-item">
      <FileCard
        ref={ref}
        glyph={<FileText aria-hidden="true" />}
        label="DOC"
        name={link.target_label}
        caption={`Document · ${caption}`}
        still={
          <DocumentPage
            id={link.target_id}
            title={link.target_label}
            wanted={near}
          />
        }
        onOpen={() => openDocument?.(link.target_id)}
        action={action}
        width={cardWidth}
      />
    </li>
  );
}
