import { useEffect, useState } from "react";
import { attachments, type Attachment } from "@/lib/api/attachments";
import { fileType, type FileFamily } from "./file-words";

/** What a Drive reference is, in the card's words: the caption's word, the tile's label and glyph. */
export type DriveType = { word: string; label: string; family: FileFamily };

const NATIVE: Record<string, DriveType> = {
  "application/vnd.google-apps.document": {
    word: "Doc",
    label: "DOC",
    family: "text",
  },
  "application/vnd.google-apps.spreadsheet": {
    word: "Sheet",
    label: "SHEET",
    family: "table",
  },
  "application/vnd.google-apps.presentation": {
    word: "Slides",
    label: "SLIDES",
    family: "file",
  },
};

/**
 * The type of a Drive reference from the last-known details of the Drive file
 * (its mime type, then the extension of its name), or null when they say
 * nothing useful; the card then shows only "Google Drive".
 */
export function driveType(metadata: {
  name: string;
  mime_type: string;
}): DriveType | null {
  const native = NATIVE[metadata.mime_type];
  if (native) return native;
  const known = fileType(metadata.name, metadata.mime_type);
  const dot = metadata.name.lastIndexOf(".");
  const extension = dot > 0 ? metadata.name.slice(dot + 1) : "";
  if (known.family === "file" && !extension) return null;
  return {
    word: known.family === "file" ? extension.toUpperCase() : known.word,
    label:
      extension && extension.length <= 5 ? extension.toUpperCase() : "FILE",
    family: known.family,
  };
}

/**
 * The type of a Drive reference's card, read from its last-known details once
 * `wanted` (the card is near the viewport). Without a Drive reference, or until
 * the details answer, there is none.
 */
export function useDriveType(
  file: Attachment,
  wanted: boolean,
): DriveType | null {
  const external = file.kind === "external_reference";
  const [found, setFound] = useState<{
    id: string;
    type: DriveType | null;
  } | null>(null);
  useEffect(() => {
    if (!wanted || !external) return;
    let current = true;
    attachments
      .driveInfo(file.id)
      .then((reference) => {
        if (current)
          setFound({ id: file.id, type: driveType(reference.metadata) });
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [wanted, external, file.id]);
  return external && found?.id === file.id ? found.type : null;
}
