import type { ReactElement } from "react";
import { AttachmentCard } from "@/features/attachments/AttachmentCard";
import type { Attachment } from "@/lib/api/attachments";
import { useAvailability } from "@/features/sync-review/availability";

/**
 * The attached files as card items. Each opens its preview.
 */
export function useAttachmentItems(
  files: Attachment[],
  onOpen: (file: Attachment) => void,
  cardWidth: number,
): ReactElement[] {
  const availability = useAvailability(
    files
      .filter((file) => file.kind !== "external_reference")
      .map((file) => file.id),
  );
  return files.map((file) => (
    <li key={file.id} className="file-card-item">
      <AttachmentCard
        file={file}
        storage={availability.of(file.id)}
        storageKnown={availability.known}
        onOpen={() => onOpen(file)}
        width={cardWidth}
      />
    </li>
  ));
}
