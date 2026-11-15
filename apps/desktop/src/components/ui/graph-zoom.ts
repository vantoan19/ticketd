/** Zoom limits every graph shares. Fit never goes below 100%; the canvas pans. */
export const GRAPH_ZOOM = { min: 0.5, max: 2, fit: 1 } as const;

/** React Flow takes milliseconds; CSS owns the duration and reduced-motion value. */
export function graphMotionDuration() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return 0;
  const token = getComputedStyle(document.documentElement)
    .getPropertyValue("--dur-settle")
    .trim();
  return Number.parseFloat(token) * (token.endsWith("ms") ? 1 : 1000) || 0;
}
