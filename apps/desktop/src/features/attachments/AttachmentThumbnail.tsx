import { useEffect, useState } from "react";
import {
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
} from "lucide-react";
import { attachments, type Attachment } from "@/lib/api/attachments";
import { fileType, type FileFamily } from "./file-words";
import "./attachment-thumbnail.css";

const ICONS: Record<FileFamily, typeof File> = {
  image: FileImage,
  audio: FileAudio,
  video: FileVideo,
  text: FileText,
  pdf: FileText,
  archive: FileArchive,
  file: File,
};

/** The glyph of a file's family: image, audio, video, text, archive (AT-24). */
export function FileIcon({
  family,
  className,
}: {
  family: FileFamily;
  className?: string;
}) {
  const Icon = ICONS[family];
  return <Icon aria-hidden="true" {...(className && { className })} />;
}

/**
 * Decorative only: the file's authored name and actions remain outside the thumbnail.
 * `icon` is the 36px tile of the rail and pickers, `row` the 24px tile of a
 * library row, `tile` the 96×72 image tile a Chat message shows. Images sit
 * on a checkerboard so a white or transparent one stays visible.
 */
export function AttachmentThumbnail({
  file,
  size = "icon",
}: {
  file: Attachment;
  size?: "icon" | "row" | "tile";
}) {
  const [image, setImage] = useState<{ id: string; url: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const candidate =
    file.kind === "local_snapshot" &&
    !file.quarantined &&
    // The native protocol buffers responses; a library must not auto-load many 100 MB images.
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
  const shown = candidate && image?.id === file.id && failed !== file.id;
  return (
    <span
      className="file-thumb"
      data-size={size === "icon" ? undefined : size}
      data-image={shown ? "" : undefined}
      aria-hidden="true"
    >
      {shown ? (
        <img
          src={image.url}
          loading="lazy"
          alt=""
          onError={() => setFailed(file.id)}
        />
      ) : (
        <FileIcon family={fileType(file.original_filename).family} />
      )}
    </span>
  );
}
