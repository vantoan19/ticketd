import { RecordLink } from "@/components/ui/record-link";
import { useEffect, useState, type ReactNode } from "react";
import { attachments } from "@/lib/api/attachments";
import { fileType, type FileFamily } from "./file-words";
import { FileIcon } from "./AttachmentThumbnail";
import "./file-card.css";
import {
  AttachmentPreview,
  type ReferenceReplacement,
} from "./AttachmentPreview";

/** The glyph of a link's file family, once the reference resolves. */
function useFamily(uri: string, wanted: boolean) {
  const [found, setFound] = useState<{ uri: string; family: FileFamily }>();
  useEffect(() => {
    if (!wanted) return;
    let current = true;
    attachments
      .resolve(uri)
      .then((file) => {
        if (current)
          setFound({ uri, family: fileType(file.original_filename).family });
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [uri, wanted]);
  return found?.uri === uri ? found.family : undefined;
}

/**
 * An authored inline label. Opening captures the exact selected reference. With
 * `glyph`, a 14px glyph of the file's family leads the words, so a link in a
 * sentence reads as a file.
 */
export function AttachmentLink({
  uri,
  children,
  onReplace,
  glyph = false,
}: {
  uri: string;
  children: ReactNode;
  onReplace?: ReferenceReplacement | undefined;
  glyph?: boolean;
}) {
  const family = useFamily(uri, glyph);
  const [preview, setPreview] = useState<{
    uri: string;
    replace: typeof onReplace;
  } | null>(null);
  return (
    <>
      <RecordLink onClick={() => setPreview({ uri, replace: onReplace })}>
        {family && (
          <FileIcon family={family} className="attachment-link-glyph" />
        )}
        {children}
      </RecordLink>
      {preview && (
        <AttachmentPreview
          target={{ uri: preview.uri }}
          onClose={() => setPreview(null)}
          onReplace={preview.replace}
        />
      )}
    </>
  );
}
