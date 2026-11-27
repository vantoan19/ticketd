import { useEffect, useState } from "react";
import { attachments, type Attachment } from "@/lib/api/attachments";
import { prepareReport } from "./html-report";
import { purged } from "./file-words";
import { openPdf } from "./pdf-document";
import { cardWorkspace, readCardPreview } from "./card-preview";

/** A picture's still is the picture itself, up to the inline limit. */
const IMAGE_LIMIT = 5 * 1024 * 1024;
/** A report is read whole for its still, so the larger ones keep their tile. */
const HTML_LIMIT = 2 * 1024 * 1024;
/** A PDF is read whole for its first page, so only the smaller ones get a still. */
const PDF_LIMIT = 8 * 1024 * 1024;
/** The first page is drawn this wide: the paper in a card is 109px, at 2x with room. */
const PAPER_WIDTH = 240;
const PAPER_MAX_HEIGHT = 480;
const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const HTML = /\.html?$/i;
const PDF = /\.pdf$/i;

/** What a card could show in place of its tile, from the file alone. */
export function stillKind(file: Attachment): "image" | "html" | "pdf" | null {
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
  if (PDF.test(file.original_filename) && file.size_bytes <= PDF_LIMIT)
    return "pdf";
  return null;
}

export type Still =
  | { id: string; kind: "image"; url: string }
  | { id: string; kind: "html"; srcdoc: string }
  | { id: string; kind: "pdf"; url: string; pages: number };

// Reports are read whole, one or two at a time, and the last few are kept so
// folding a list or revisiting a ticket does not read them again. A replaced
// file has a new id, so an entry is never stale. `null` is "no still" for a report;
// a PDF that failed to draw is not kept, so it is tried again.
const CONCURRENT = 2;
const KEPT = 8;
const kept = new Map<string, string | null>();
const keptPages = new Map<string, { url: string; pages: number }>();
const waiting: Array<() => void> = [];
let running = 0;

/** Starts waiting reads while there is room. A read whose card has left is dropped
 *  without taking a turn, so it can never hold up the ones behind it. */
function pump() {
  while (running < CONCURRENT) {
    const next = waiting.shift();
    if (!next) return;
    next();
  }
}

function schedule<T>(task: () => Promise<T>, cancelled: () => boolean) {
  return new Promise<T | undefined>((resolve, reject) => {
    waiting.push(() => {
      if (cancelled()) {
        resolve(undefined);
        return;
      }
      running += 1;
      task()
        .then(resolve, reject)
        .finally(() => {
          running -= 1;
          pump();
        });
    });
    pump();
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

/** The first page of a stored PDF, drawn once as a small image. */
async function pdfStill(
  workspace: string,
  id: string,
  cancelled: () => boolean,
) {
  const key = `${workspace}/${id}`;
  const had = keptPages.get(key);
  if (had) return had;
  const still = await schedule(async () => {
    const document = await openPdf(await attachments.pdf(workspace, id));
    try {
      const first = document.pages[0]!;
      const scale = Math.min(
        PAPER_WIDTH / first.width,
        PAPER_MAX_HEIGHT / first.height,
      );
      const canvas = window.document.createElement("canvas");
      await document.render(0, canvas, scale).done;
      return {
        url: canvas.toDataURL("image/png"),
        pages: document.pages.length,
      };
    } finally {
      document.destroy();
    }
  }, cancelled);
  // A failure is not kept: it may be only that the file was not here yet, and the
  // card asks again when it is. (`useStill` leaves the tile on a failure.)
  if (still === undefined) return null;
  keptPages.set(key, still);
  if (keptPages.size > KEPT) keptPages.delete(keptPages.keys().next().value!);
  return still;
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
      const workspace = await cardWorkspace();
      if (kind === "image") {
        const info = await readCardPreview(workspace, file.id);
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
      if (kind === "pdf") {
        const page = await pdfStill(workspace, file.id, () => !current);
        if (current && page) setStill({ id: file.id, kind, ...page });
        return;
      }
      const srcdoc = await reportStill(workspace, file.id, () => !current);
      if (current && srcdoc) setStill({ id: file.id, kind, srcdoc });
    })().catch(() => {});
    return () => {
      current = false;
    };
  }, [wanted, kind, file.id]);
  return wanted && kind && still?.id === file.id ? still : null;
}
