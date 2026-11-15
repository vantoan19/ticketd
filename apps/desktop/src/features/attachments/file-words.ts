import type { Attachment, AttachmentUsage } from "@/lib/api/attachments";

/** What a file is, for its icon: one glyph per family (shell AT-24). */
export type FileFamily =
  "image" | "audio" | "video" | "text" | "pdf" | "archive" | "file";

const TYPES: Record<string, [string, FileFamily]> = {
  png: ["PNG image", "image"],
  jpg: ["JPEG image", "image"],
  jpeg: ["JPEG image", "image"],
  gif: ["GIF image", "image"],
  webp: ["WebP image", "image"],
  bmp: ["BMP image", "image"],
  svg: ["SVG image", "image"],
  heic: ["HEIC image", "image"],
  mp3: ["MP3 audio", "audio"],
  wav: ["WAV audio", "audio"],
  ogg: ["Ogg audio", "audio"],
  m4a: ["M4A audio", "audio"],
  mp4: ["MP4 video", "video"],
  webm: ["WebM video", "video"],
  mov: ["QuickTime video", "video"],
  ogv: ["Ogg video", "video"],
  pdf: ["PDF", "pdf"],
  txt: ["Text", "text"],
  md: ["Markdown", "text"],
  log: ["Log", "text"],
  csv: ["CSV", "text"],
  json: ["JSON", "text"],
  yaml: ["YAML", "text"],
  yml: ["YAML", "text"],
  xml: ["XML", "text"],
  html: ["HTML", "text"],
  zip: ["ZIP archive", "archive"],
  gz: ["Gzip archive", "archive"],
  tgz: ["Gzip archive", "archive"],
  tar: ["TAR archive", "archive"],
  "7z": ["7-Zip archive", "archive"],
};

const MEDIA: Record<string, [string, FileFamily]> = {
  "image/png": ["PNG image", "image"],
  "image/jpeg": ["JPEG image", "image"],
  "image/gif": ["GIF image", "image"],
  "image/webp": ["WebP image", "image"],
  "image/bmp": ["BMP image", "image"],
  "audio/mpeg": ["MP3 audio", "audio"],
  "audio/wav": ["WAV audio", "audio"],
  "audio/ogg": ["Ogg audio", "audio"],
  "audio/mp4": ["M4A audio", "audio"],
  "video/mp4": ["MP4 video", "video"],
  "video/webm": ["WebM video", "video"],
  "video/ogg": ["Ogg video", "video"],
  "text/plain": ["Text", "text"],
};

function extension(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * The file's type in human words ("PNG image", "WAV audio", "PDF") and its
 * family, from the detected media type when the core knows it, else from the
 * original name. Never a MIME type (shell AT-09).
 */
export function fileType(
  name: string,
  mediaType?: string | null,
): { word: string; family: FileFamily } {
  const known = (mediaType && MEDIA[mediaType]) || TYPES[extension(name)];
  if (known) return { word: known[0], family: known[1] };
  const ext = extension(name);
  return {
    word: ext && ext.length <= 5 ? `${ext.toUpperCase()} file` : "File",
    family: "file",
  };
}

/**
 * Where a file is used, in one or two words (P20): "Unused", "Used in 1",
 * "Used in 2", or "Kept for recovery" while older recovery drafts may still
 * hold it.
 */
export function usageWord(usage: AttachmentUsage) {
  const count = usage.protections.length;
  if (count) return `Used in ${count}`;
  return usage.legacy_drafts_pending ? "Kept for recovery" : "Unused";
}

/** A file whose bytes ticketd no longer keeps, or is about to delete. */
export function purged(file: Attachment) {
  return file.purge_state === "purged" || file.purge_state === "pending";
}

/** The one state word a row shows beside its caption, if any (P20). */
export function stateWord(file: Attachment, missing = false): string | null {
  if (file.purge_state === "purged") return "Deleted";
  if (file.purge_state === "pending") return "Deleting";
  if (file.quarantined) return "Quarantined";
  if (missing) return "Missing";
  return null;
}
