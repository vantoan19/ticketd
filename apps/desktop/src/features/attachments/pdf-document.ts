import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

/** A page's size in CSS pixels at 100%. */
export type PdfPageSize = { width: number; height: number };

export type PdfRender = { done: Promise<void>; cancel: () => void };

/**
 * A parsed PDF, as much of pdf.js as the viewer and the card still need. This is
 * the only file that imports the library, and it loads lazily, so the app opens
 * without it and tests replace this module whole.
 */
export interface PdfDocument {
  readonly pages: readonly PdfPageSize[];
  /** Paints one page into `canvas`, whose pixel size becomes `scale` times its 100% size. */
  render(index: number, canvas: HTMLCanvasElement, scale: number): PdfRender;
  destroy(): void;
}

/** The file could not be opened as a PDF: damaged, protected or not a PDF at all. */
export class PdfUnreadable extends Error {
  constructor(options?: { cause: unknown }) {
    super("This PDF could not be rendered.", options);
    this.name = "PdfUnreadable";
  }
}

const SIZE_BATCH = 64;

/**
 * Opens a PDF from its bytes. Nothing leaves this computer and nothing runs from
 * the file: the worker is bundled with the app (same origin, no CDN), scripting
 * and XFA forms are off, fonts are drawn as glyph shapes rather than loaded as
 * font files, and WASM image decoders and external resource files are not
 * fetched (the app's CSP allows no network, not even to itself).
 */
export async function openPdf(bytes: Uint8Array): Promise<PdfDocument> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({
    data: bytes,
    disableFontFace: true,
    useSystemFonts: true,
    useWasm: false,
    useWorkerFetch: false,
    enableXfa: false,
    disableAutoFetch: true,
    disableStream: true,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });
  try {
    const document = await task.promise;
    const sizes: PdfPageSize[] = [];
    for (let first = 1; first <= document.numPages; first += SIZE_BATCH) {
      const batch = await Promise.all(
        Array.from(
          { length: Math.min(SIZE_BATCH, document.numPages - first + 1) },
          async (_, offset) => {
            const page = await document.getPage(first + offset);
            const { width, height } = page.getViewport({ scale: 1 });
            page.cleanup();
            return { width, height };
          },
        ),
      );
      sizes.push(...batch);
    }
    if (sizes.length === 0) throw new Error("The PDF has no pages.");
    return {
      pages: sizes,
      render(index, canvas, scale) {
        let cancelled = false;
        let running: { cancel(): void } | null = null;
        const done = (async () => {
          const page = await document.getPage(index + 1);
          if (cancelled) return;
          const viewport = page.getViewport({ scale });
          canvas.width = Math.max(1, Math.floor(viewport.width));
          canvas.height = Math.max(1, Math.floor(viewport.height));
          running = page.render({ canvas, viewport });
          try {
            await (running as ReturnType<typeof page.render>).promise;
          } catch (reason) {
            if (!(reason instanceof pdfjs.RenderingCancelledException))
              throw reason;
          } finally {
            page.cleanup();
          }
        })();
        return {
          done,
          cancel() {
            cancelled = true;
            running?.cancel();
          },
        };
      },
      destroy() {
        void task.destroy();
      },
    };
  } catch (reason) {
    void task.destroy();
    throw new PdfUnreadable({ cause: reason });
  }
}
