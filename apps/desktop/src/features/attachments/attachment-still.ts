import { useEffect, useState } from "react";
import { attachments, type Attachment } from "@/lib/api/attachments";
import { prepareReport } from "./html-report";
import { purged } from "./file-words";

/** A picture's still is the picture itself, up to the inline limit. */
const IMAGE_LIMIT = 5 * 1024 * 1024;
/** A report is read whole for its still, so the larger ones keep their tile. */
const HTML_LIMIT = 2 * 1024 * 1024;
const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const HTML = /\.html?$/i;

/** What a card could show in place of its tile, from the file alone. */
export function stillKind(file: Attachment): "image" | "html" | null {
  if (
    file.kind !== "local_snapshot" ||
    file.quarantined ||
    purged(file) ||
    file.size_bytes === null
  )
    return null;
  if (IMAGE.test(file.original_filename) && file.size_bytes <= IMAGE_LIMIT)
    return "image";
  if (HTML.test(file.original_filename) && file.size_bytes <= HTML_LIMIT)
    return "html";
  return null;
}

export type Still =
  | { id: string; kind: "image"; url: string }
  | { id: string; kind: "html"; srcdoc: string };

// Reports are read whole, one or two at a time, and the last few are kept so
// folding a list or revisiting a ticket does not read them again. A replaced
// file has a new id, so an entry is never stale. `null` is "no still".
const CONCURRENT = 2;
const KEPT = 8;
const kept = new Map<string, string | null>();
const waiting: Array<() => void> = [];
let running = 0;

function schedule<T>(task: () => Promise<T>, cancelled: () => boolean) {
  return new Promise<T | undefined>((resolve, reject) => {
    const start = () => {
      if (cancelled()) {
        resolve(undefined);
        return;
      }
      running += 1;
      task()
        .then(resolve, reject)
        .finally(() => {
          running -= 1;
          waiting.shift()?.();
        });
    };
    if (running < CONCURRENT) start();
    else waiting.push(start);
  });
}

async function reportStill(
  workspace: string,
  id: string,
  cancelled: () => boolean,
) {
  const key = `${workspace}/${id}`;
  if (kept.has(key)) return kept.get(key) ?? null;
  const source = await schedule(
    () => attachments.html(workspace, id),
    cancelled,
  );
  if (source === undefined) return null;
  const report = prepareReport(source);
  const srcdoc = report.unusable ? null : report.srcdoc;
  kept.set(key, srcdoc);
  if (kept.size > KEPT) kept.delete(kept.keys().next().value!);
  return srcdoc;
}

/**
 * The still for a card, asked for only once `wanted` (the card is near the
 * viewport). A failure, an unsupported file or a report that cannot show leaves
 * the labeled tile, silently.
 */
export function useStill(file: Attachment, wanted: boolean): Still | null {
  const kind = stillKind(file);
  const [still, setStill] = useState<Still | null>(null);
  useEffect(() => {
    if (!wanted || !kind) return;
    let current = true;
    void (async () => {
      const workspace = await attachments.workspaceId();
      if (kind === "image") {
        const info = await attachments.preview(workspace, file.id);
        if (
          current &&
          info.status === "available" &&
          info.media_type?.startsWith("image/")
        )
          setStill({
            id: file.id,
            kind,
            url: attachments.mediaUrl(workspace, file.id),
          });
        return;
      }
      const srcdoc = await reportStill(workspace, file.id, () => !current);
      if (current && srcdoc) setStill({ id: file.id, kind, srcdoc });
    })().catch(() => {});
    return () => {
      current = false;
    };
  }, [wanted, kind, file.id]);
  return kind && still?.id === file.id ? still : null;
}
