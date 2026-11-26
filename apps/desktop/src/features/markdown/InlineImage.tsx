import { useEffect, useState } from "react";
import { ImageIcon } from "lucide-react";
import { AttachmentLink } from "@/features/attachments/AttachmentLink";
import type { ReferenceReplacement } from "@/features/attachments/AttachmentPreview";
import { PlacePreview } from "@/features/attachments/AttachmentPlace";
import { attachments } from "@/lib/api/attachments";

/** Pictures larger than this keep their label; the preview still opens them. */
const INLINE_LIMIT = 5 * 1024 * 1024;
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp)$/i;

/**
 * Where a stored attachment image can be drawn from, once it is known to be
 * a local picture small enough to show inline; null keeps the label.
 */
function useInlineImage(uri: string) {
  const [shown, setShown] = useState<{ uri: string; url: string } | null>(null);
  useEffect(() => {
    let current = true;
    void (async () => {
      const file = await attachments.resolve(uri);
      if (
        file.kind !== "local_snapshot" ||
        file.quarantined ||
        file.size_bytes === null ||
        file.size_bytes > INLINE_LIMIT ||
        !IMAGE_FILE.test(file.original_filename)
      )
        return;
      const workspace = await attachments.workspaceId();
      const info = await attachments.preview(workspace, file.id);
      if (
        current &&
        info.status === "available" &&
        info.media_type?.startsWith("image/")
      )
        setShown({ uri, url: attachments.mediaUrl(workspace, file.id) });
    })().catch(() => {});
    return () => {
      current = false;
    };
  }, [uri]);
  return shown?.uri === uri ? shown.url : null;
}

/**
 * An attachment image written into Markdown (`![Board](ticketd://attachment/…)`):
 * the picture itself, at most the column's width, and a click opens the shared
 * preview. A file that is not a picture, too large, or unavailable reads as its
 * label, a link to the same preview (detA MK-02).
 */
export function AttachmentImage({
  uri,
  alt,
  onReplace,
}: {
  uri: string;
  alt: string;
  onReplace?: ReferenceReplacement | undefined;
}) {
  const url = useInlineImage(uri);
  const [failed, setFailed] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const label = alt || "Attachment";
  if (!url || failed === url)
    return (
      <AttachmentLink uri={uri} onReplace={onReplace}>
        {label}
      </AttachmentLink>
    );
  return (
    <>
      <button
        type="button"
        className="markdown-image"
        aria-label={`Open ${label}`}
        onClick={() => setOpen(true)}
      >
        <img src={url} alt={alt} onError={() => setFailed(url)} />
      </button>
      {open && (
        <PlacePreview
          uri={uri}
          onClose={() => setOpen(false)}
          onReplace={onReplace}
        />
      )}
    </>
  );
}

/**
 * The same picture inside the rich editor, where it is one unit of the text:
 * an attachment draws its image, anything else reads as its label.
 */
export function EditorImage({ url, alt }: { url: string; alt: string }) {
  if (url.startsWith("ticketd://attachment/"))
    return <AttachmentImage uri={url} alt={alt} />;
  return (
    <span className="editor-image-label">
      <ImageIcon aria-hidden="true" />
      {alt || url}
    </span>
  );
}
