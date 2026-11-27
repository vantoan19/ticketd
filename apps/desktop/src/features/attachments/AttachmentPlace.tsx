import { useContext, useEffect, useState } from "react";
import { attachments, type Attachment } from "@/lib/api/attachments";
import {
  AttachmentPreview,
  type ReferenceReplacement,
} from "./AttachmentPreview";
import { AttachmentPlace, type PlaceFile } from "./attachment-place";

type Resolved = {
  uri: string;
  file: Attachment;
  replace: PlaceFile["replace"];
};

/** Every file of the place, once each: a file linked twice counts once. */
async function resolveAll(listed: PlaceFile[]): Promise<Resolved[]> {
  const settled = await Promise.all(
    listed.map(async (entry) => {
      try {
        return { ...entry, file: await attachments.resolve(entry.uri) };
      } catch {
        return null;
      }
    }),
  );
  const seen = new Set<string>();
  const files: Resolved[] = [];
  for (const entry of settled) {
    if (!entry || seen.has(entry.file.id)) continue;
    seen.add(entry.file.id);
    files.push(entry);
  }
  return files;
}

/**
 * The viewer for a link, card or picture. When its text holds other files,
 * Previous and Next walk them in reading order; alone, the file opens by itself.
 */
export function PlacePreview({
  uri,
  onClose,
  onReplace,
}: {
  uri: string;
  onClose: () => void;
  onReplace?: ReferenceReplacement | undefined;
}) {
  const place = useContext(AttachmentPlace);
  const [listed] = useState(() => {
    const entries = place?.() ?? [];
    return entries.length > 1 && entries.some((entry) => entry.uri === uri)
      ? entries
      : [];
  });
  // Resolved before the viewer opens, so its header never gains arrows late.
  const [files, setFiles] = useState<Resolved[] | null>(
    listed.length ? null : [],
  );
  const [selected, setSelected] = useState<Attachment | null>(null);
  useEffect(() => {
    if (!listed.length) return;
    let current = true;
    void resolveAll(listed).then((all) => current && setFiles(all));
    return () => {
      current = false;
    };
  }, [listed]);
  if (files === null) return null;
  const opened = files.find((entry) => entry.uri === uri)?.file;
  const shown = selected ?? opened;
  const replace =
    selected && selected.id !== opened?.id
      ? files.find((entry) => entry.file.id === selected.id)?.replace
      : onReplace;
  return (
    <AttachmentPreview
      // One viewer for the whole walk: a step changes the target, not the viewer.
      target={shown ? { id: shown.id, initial: shown } : { uri }}
      browse={{
        files: files.map((entry) => entry.file),
        onSelect: setSelected,
      }}
      onClose={onClose}
      onReplace={replace}
    />
  );
}
