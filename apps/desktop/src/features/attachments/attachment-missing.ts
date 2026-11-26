import { useEffect, useState } from "react";
import { attachments, type Attachment } from "@/lib/api/attachments";
import { purged } from "./file-words";

/**
 * Whether a kept local file's stored copy is gone from this computer, for the
 * card's "Missing" caption. Asked only once `wanted` (the card is near the
 * viewport, and the file is not simply waiting in the sync storage). A failed
 * read says nothing, so the card stays as it was.
 */
export function useMissing(file: Attachment, wanted: boolean): boolean {
  const asks =
    file.kind === "local_snapshot" && !file.quarantined && !purged(file);
  const [found, setFound] = useState<{ id: string; missing: boolean } | null>(
    null,
  );
  useEffect(() => {
    if (!wanted || !asks) return;
    let current = true;
    void (async () => {
      const workspace = await attachments.workspaceId();
      const info = await attachments.preview(workspace, file.id);
      if (current)
        setFound({
          id: file.id,
          missing: info.status === "missing" || info.status === "incomplete",
        });
    })().catch(() => {});
    return () => {
      current = false;
    };
  }, [wanted, asks, file.id]);
  return wanted && asks && found?.id === file.id && found.missing;
}
