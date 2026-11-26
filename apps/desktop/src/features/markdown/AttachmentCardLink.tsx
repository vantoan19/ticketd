import { useEffect, useState } from "react";
import { File } from "lucide-react";
import { AttachmentCard } from "@/features/attachments/AttachmentCard";
import { AttachmentLink } from "@/features/attachments/AttachmentLink";
import {
  AttachmentPreview,
  type ReferenceReplacement,
} from "@/features/attachments/AttachmentPreview";
import { FileCard } from "@/features/attachments/FileCard";
import { attachments, type Attachment } from "@/lib/api/attachments";
import { useAvailability } from "@/features/sync-review/availability";

/**
 * An attachment link that stands alone on its line, as a card. The viewer opens
 * on the exact reference. A reference that can't be resolved stays an ordinary
 * link, and until it is known the card holds its place with the authored label.
 */
export function AttachmentCardLink({
  uri,
  label,
  onReplace,
}: {
  uri: string;
  label: string | undefined;
  onReplace?: ReferenceReplacement | undefined;
}) {
  const [found, setFound] = useState<
    { uri: string; file: Attachment | null } | undefined
  >();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let current = true;
    attachments.resolve(uri).then(
      (file) => current && setFound({ uri, file }),
      () => current && setFound({ uri, file: null }),
    );
    return () => {
      current = false;
    };
  }, [uri]);
  const file = found?.uri === uri ? found.file : undefined;
  const availability = useAvailability(
    file && file.kind === "local_snapshot" ? [file.id] : [],
  );
  if (file === null)
    return (
      <AttachmentLink uri={uri} onReplace={onReplace}>
        {label ?? "Attachment"}
      </AttachmentLink>
    );
  return (
    <>
      {file ? (
        <AttachmentCard
          file={file}
          label={label}
          storage={availability.of(file.id)}
          storageKnown={availability.known}
          onOpen={() => setOpen(true)}
        />
      ) : (
        <FileCard
          name={label ?? "Attachment"}
          caption=""
          glyph={<File aria-hidden="true" />}
          label="FILE"
          onOpen={() => setOpen(true)}
        />
      )}
      {open && (
        <AttachmentPreview
          target={{ uri }}
          onClose={() => setOpen(false)}
          onReplace={onReplace}
        />
      )}
    </>
  );
}
