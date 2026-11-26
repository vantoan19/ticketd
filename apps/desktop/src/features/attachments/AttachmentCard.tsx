import { useState, type ReactNode } from "react";
import type { Attachment } from "@/lib/api/attachments";
import type { Availability } from "@/lib/sync-review-api";
import { formatSize } from "./format-size";
import { fileType, stateWord } from "./file-words";
import { FileIcon } from "./AttachmentThumbnail";
import { FileCard } from "./FileCard";
import { useStill } from "./attachment-still";
import { useNearViewport } from "./use-near-viewport";

/** The tile's word: the extension (`LOG`, `P12`), with `↗` for a Drive reference. */
function tileLabel(file: Attachment) {
  const dot = file.original_filename.lastIndexOf(".");
  const extension =
    dot > 0 ? file.original_filename.slice(dot + 1).toUpperCase() : "";
  const word = extension && extension.length <= 5 ? extension : "FILE";
  return file.kind === "external_reference" ? `${word} ↗` : word;
}

/**
 * The caption: the app's own type word and the size ("PNG image · 97 KB"). The
 * storage replaces the type word only when the file isn't simply on this
 * computer: "Not downloaded · 3.4 MB", "Quarantined · 2.1 MB".
 */
function cardCaption(file: Attachment, storage?: Availability) {
  if (file.kind === "external_reference")
    return file.uploaded_copy
      ? "Google Drive · Uploaded copy"
      : "Google Drive · External reference";
  const lead =
    stateWord(file) ??
    (storage?.state === "downloading"
      ? "Downloading…"
      : storage?.state === "not_downloaded"
        ? "Not downloaded"
        : fileType(file.original_filename).word);
  return `${lead} · ${formatSize(file.size_bytes)}`;
}

/**
 * A stored file as a card: the labeled tile at once, and a still of its
 * picture or first screen once the card is within a screen of the viewport.
 * A file that isn't here yet keeps its tile. One action opens the shared viewer.
 */
export function AttachmentCard({
  file,
  label,
  storage,
  onOpen,
  action,
}: {
  file: Attachment;
  /** An authored label that differs from the file's name: it names the card. */
  label?: string | undefined;
  storage?: Availability | undefined;
  onOpen: () => void;
  action?: ReactNode;
}) {
  const [ref, near] = useNearViewport<HTMLDivElement>();
  const here = storage === undefined || storage.state === "downloaded";
  const still = useStill(file, near && here);
  const [broken, setBroken] = useState<string | null>(null);
  const named = label && label !== file.display_name ? label : undefined;
  return (
    <FileCard
      ref={ref}
      name={named ?? file.display_name}
      tooltip={named ? file.display_name : undefined}
      caption={cardCaption(file, storage)}
      glyph={<FileIcon family={fileType(file.original_filename).family} />}
      label={tileLabel(file)}
      still={
        still?.kind === "image" && broken !== still.id ? (
          <img
            className="file-card-still"
            src={still.url}
            alt=""
            loading="lazy"
            onError={() => setBroken(still.id)}
          />
        ) : still?.kind === "html" ? (
          <iframe
            className="file-card-still"
            aria-hidden="true"
            tabIndex={-1}
            inert
            // The same isolation as the viewer's report: no scripts, no network.
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={still.srcdoc}
          />
        ) : undefined
      }
      onOpen={onOpen}
      action={action}
    />
  );
}
