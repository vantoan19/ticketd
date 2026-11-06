export function formatSize(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
    : bytes >= 1024
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : `${bytes} B`;
}
