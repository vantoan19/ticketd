import { useEffect, useState } from "react";
import { AudioLines, File, FileVideo } from "lucide-react";
import { attachments, type Attachment } from "@/lib/api/attachments";

/** Decorative only: the file's authored name and actions remain outside the thumbnail. */
export function AttachmentThumbnail({ file }: { file: Attachment }) {
  const [image, setImage] = useState<{ id: string; url: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const candidate =
    file.kind === "local_snapshot" &&
    // The native protocol buffers responses; a library must not auto-load many 100 MiB images.
    // Larger images keep their icon and remain available through the explicit shared preview.
    file.size_bytes !== null &&
    file.size_bytes <= 5 * 1024 * 1024 &&
    /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.original_filename);
  useEffect(() => {
    if (!candidate) return;
    let current = true;
    void (async () => {
      const workspace = await attachments.workspaceId();
      const info = await attachments.preview(workspace, file.id);
      if (
        current &&
        info.status === "available" &&
        info.media_type?.startsWith("image/")
      )
        setImage({
          id: file.id,
          url: attachments.mediaUrl(workspace, file.id),
        });
    })().catch(() => {});
    return () => {
      current = false;
    };
  }, [candidate, file.id]);
  const Icon = /\.(mp4|webm|mov|ogv)$/i.test(file.original_filename)
    ? FileVideo
    : /\.(mp3|wav|ogg|m4a)$/i.test(file.original_filename)
      ? AudioLines
      : File;
  return (
    <span className="attachment-thumbnail" aria-hidden="true">
      {candidate && image?.id === file.id && failed !== file.id ? (
        <img
          src={image.url}
          loading="lazy"
          alt=""
          onError={() => setFailed(file.id)}
        />
      ) : (
        <Icon />
      )}
    </span>
  );
}
