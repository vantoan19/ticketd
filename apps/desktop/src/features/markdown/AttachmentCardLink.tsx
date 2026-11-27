import { useEffect, useState } from "react";
import { File } from "lucide-react";
import { AttachmentCard } from "@/features/attachments/AttachmentCard";
import { AttachmentLink } from "@/features/attachments/AttachmentLink";
import type { ReferenceReplacement } from "@/features/attachments/AttachmentPreview";
import { PlacePreview } from "@/features/attachments/AttachmentPlace";
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
  // The reference and replacement the viewer opened on: a later edit of the text
  // must not retarget an open viewer or its Replace picker.
  const [opened, setOpened] = useState<{
    uri: string;
    replace: typeof onReplace;
  } | null>(null);
  const open = () => setOpened({ uri, replace: onReplace });
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
  // A Replace rewrites the address in place: until the new one answers the card keeps
  // showing the file it had, so it stays one element and focus can come back to it.
  const file = found?.file;
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
          onOpen={open}
        />
      ) : (
        <FileCard
          name={label ?? "Attachment"}
          caption=""
          glyph={<File aria-hidden="true" />}
          label="FILE"
          onOpen={open}
        />
      )}
      {opened && (
        <PlacePreview
          uri={opened.uri}
          onClose={() => setOpened(null)}
          onReplace={opened.replace}
        />
      )}
    </>
  );
}
