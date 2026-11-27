import { vi } from "vitest";
import type { PdfDocument } from "@/features/attachments/pdf-document";

/**
 * A PDF with `count` pages of US Letter (612 × 792) for tests that replace
 * `pdf-document`. `renders` records every page paint as [index, pixel scale].
 */
export function fakePdf(count: number, size = { width: 612, height: 792 }) {
  const renders: Array<[number, number]> = [];
  const destroy = vi.fn();
  const document: PdfDocument = {
    pages: Array.from({ length: count }, () => size),
    render(index, canvas, scale) {
      renders.push([index, scale]);
      canvas.width = Math.floor(size.width * scale);
      canvas.height = Math.floor(size.height * scale);
      return { done: Promise.resolve(), cancel() {} };
    },
    destroy,
  };
  return { document, renders, destroy };
}
