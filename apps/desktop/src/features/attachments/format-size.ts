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

/**
 * "1.2 of 3.4 MB": both numbers in the unit of the total, so a download reads
 * as one measure. Byte counts are whole numbers, never fractions of a byte.
 */
export function formatProgress(received: number, total: number) {
  const all = formatSize(Math.round(total));
  const [, unit = "B"] = all.split(" ");
  const bytes = Math.max(0, Math.min(Math.round(received), Math.round(total)));
  if (unit === "B") return `${bytes} of ${all}`;
  const scale = 1024 ** (UNITS.indexOf(unit as (typeof UNITS)[number]) + 1);
  const value = bytes / scale;
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${rounded} of ${all}`;
}
