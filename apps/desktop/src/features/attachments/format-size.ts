const UNITS = ["KB", "MB", "GB", "TB"] as const;

/**
 * A file size as people read it (P20): "590 B", "2.1 KB", "590 KB", "100 MB".
 * Binary steps, one decimal only below 10, and never a trailing ".0".
 */
export function formatSize(bytes: number | null) {
  if (bytes === null) return "Size unknown";
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${rounded} ${UNITS[unit]}`;
}
