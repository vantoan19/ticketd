import { useId } from "react";
import { CircleDot } from "lucide-react";

/** Load the connector's SVG as an image. Only the image's alpha masks the
 * current color. No connector markup is inserted into the document. */
export function SourceIcon({
  svg,
  size = 24,
}: {
  svg?: string | null | undefined;
  size?: number;
}) {
  const mask = useId();
  if (!svg || svg.length > 16_384) {
    return <CircleDot size={size} aria-hidden="true" />;
  }
  const href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <mask id={mask} style={{ maskType: "alpha" }}>
        <image href={href} width="24" height="24" />
      </mask>
      <rect width="24" height="24" fill="currentColor" mask={`url(#${mask})`} />
    </svg>
  );
}
