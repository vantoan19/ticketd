import { useState } from "react";
import { AttachmentPreview } from "@/features/attachments/AttachmentPreview";
import { AttachmentThumbnail } from "@/features/attachments/AttachmentThumbnail";
import type { Attachment } from "@/lib/api/attachments";
import "@/features/tickets/ticket-attachments.css";

/** Three tiles show; the rest are counted on a fourth. */
const SHOWN = 3;

/**
 * The images of a message as 96×72 tiles: three, then "+N". A tile opens the
 * Attachment preview; "+N" opens the first image it stands for.
 */
export function ImageTiles({ images }: { images: Attachment[] }) {
  const [open, setOpen] = useState<Attachment | null>(null);
  const rest = images.slice(SHOWN);
  const first = rest[0];
  return (
    <div className="chat-tiles">
      {images.slice(0, SHOWN).map((image) => (
        <button
          key={image.id}
          type="button"
          className="chat-tile"
          aria-label={`Open image ${image.display_name}`}
          onClick={() => setOpen(image)}
        >
          <AttachmentThumbnail file={image} size="tile" />
        </button>
      ))}
      {first && (
        <button
          type="button"
          className="chat-tile chat-tile-more"
          aria-label={`Open ${rest.length} more ${rest.length === 1 ? "image" : "images"}`}
          onClick={() => setOpen(first)}
        >
          +{rest.length}
        </button>
      )}
      {open && (
        <AttachmentPreview
          target={{ id: open.id, initial: open }}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
