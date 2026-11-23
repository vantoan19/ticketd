import { useTheme } from "next-themes";
import {
  useEffect,
  useRef,
  useState,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import { useHydrated } from "../components/useHydrated";
import { siteUrl } from "../links";
import { captures, viewportOf, type Screen } from "./captures";
import type { Frame } from "./framing";
import { captureFile, viewImages, type ImageTheme } from "./image-crop";

export const compactScreen = "(max-width: 759px)";
export function imageUrl(
  screen: Screen,
  theme: string,
  width: number,
  compact = false,
) {
  return siteUrl("/screens/" + captureFile(screen, theme, width, compact));
}
export type CaptureView = { tone: ImageTheme; compact: boolean };
const views: CaptureView[] = [
  { tone: "light", compact: false },
  { tone: "dark", compact: false },
  { tone: "light", compact: true },
  { tone: "dark", compact: true },
];

/** The initial HTML links to the same native window and theme as the picture.
 * Once enhanced, keep that anchor in place and update its destination. */
export function CaptureLink({
  screen,
  children,
  view,
  label,
  onClick,
}: {
  screen: Screen;
  children: ReactNode;
  view?: CaptureView | undefined;
  label?: string;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
}) {
  const [initial, setInitial] = useState<CaptureView>();
  if (!initial && view) setInitial(view);
  return (initial ? [initial] : views).map((variant) => {
    const { tone, compact } = view ?? variant;
    const { width } = viewportOf(screen, compact);
    return (
      <a
        key={variant.tone + variant.compact}
        className={
          initial
            ? undefined
            : variant.tone === "dark"
              ? "night-photo"
              : "paper-photo"
        }
        data-capture-window={
          initial ? undefined : variant.compact ? "compact" : "wide"
        }
        href={imageUrl(screen, tone, width * 2, compact)}
        aria-label={label}
        onClick={onClick}
      >
        {children}
      </a>
    );
  });
}
export function useImageTheme() {
  const { resolvedTheme } = useTheme();
  return useHydrated() ? resolvedTheme : undefined;
}
function darkMedia(theme: string | undefined) {
  if (theme === "light") return "not all";
  if (theme === "dark") return "all";
  return "(prefers-color-scheme: dark)";
}

export function ProofPhoto({
  screen,
  wide,
  phone,
  alt,
  pending,
  awaitingLoad,
  attempt,
  onLoad,
  onError,
}: {
  screen: Screen;
  wide: Frame;
  phone: Frame;
  alt: string;
  pending: boolean;
  awaitingLoad: boolean;
  attempt: number;
  onLoad: () => void;
  onError: () => void;
}) {
  const theme = useImageTheme();
  const image = useRef<HTMLImageElement>(null);
  useEffect(() => {
    // A prerendered image can fail before hydration. Returning to an already
    // loaded photo or retry can select its bitmap without another load event.
    const current = image.current;
    if (!theme || !current?.currentSrc || !current.complete) return;
    if (!current.naturalWidth) onError();
    else if (awaitingLoad) onLoad();
  }, [theme, awaitingLoad, onLoad, onError]);
  const sizes =
    "auto, (max-width: 759px) min(90vw, 590px), (max-width: 1440px) 52vw, 750px";
  // A host may cache a failed image response. Only an explicit retry needs
  // a new URL. The regular responsive images keep their shared cache keys.
  const suffix = attempt ? "?retry=" + attempt : "";
  const candidates = (tone: ImageTheme, frame: Frame) =>
    viewImages(screen, tone, frame)
      .map(({ url, width }) => siteUrl(url) + suffix + " " + width + "w")
      .join(", ");
  // A saved site theme can differ from the OS before hydration. CSS picks
  // the matching lazy picture as soon as the page paints.
  const tones: readonly ImageTheme[] =
    theme === "dark" || theme === "light" ? [theme] : ["light", "dark"];
  // Keep the same image element as the visitor changes theme. Its current
  // bitmap stays readable while the browser fetches the replacement.
  return tones.map((tone, i) => (
    <picture
      key={i === 0 ? "screen" : "system-dark"}
      data-tone={tones.length > 1 ? tone : undefined}
      className="proof-photo"
      aria-hidden={pending || undefined}
    >
      <source
        media={compactScreen}
        srcSet={candidates(tone, phone)}
        sizes={sizes}
      />
      <img
        ref={i === 0 ? image : undefined}
        src={siteUrl(viewImages(screen, tone, wide)[0]!.url) + suffix}
        srcSet={candidates(tone, wide)}
        sizes={sizes}
        width={Math.round(wide.width)}
        height={Math.round(wide.height)}
        alt={alt}
        loading={pending ? "eager" : "lazy"}
        decoding={pending ? "sync" : "async"}
        onLoad={onLoad}
        onError={onError}
      />
    </picture>
  ));
}

export function ProductImage({
  screen,
  compact,
  sizes,
  attempt,
  onLoad,
  onError,
}: {
  screen: Screen;
  compact: boolean;
  sizes: string;
  attempt: number;
  onLoad: () => void;
  onError: () => void;
}) {
  const resolvedTheme = useImageTheme();
  const { width, height } = viewportOf(screen, compact);
  const widths = compact ? [width, width * 2] : [width / 2, width, width * 2];
  const suffix = attempt ? "?retry=" + attempt : "";
  const set = (theme: string) =>
    widths
      .map((w) => imageUrl(screen, theme, w, compact) + suffix + " " + w + "w")
      .join(", ");
  return (
    <picture>
      <source
        media={darkMedia(resolvedTheme)}
        srcSet={set("dark")}
        sizes={sizes}
      />
      <img
        src={imageUrl(screen, "light", width, compact) + suffix}
        srcSet={set("light")}
        sizes={sizes}
        width={width}
        height={height}
        decoding="async"
        alt={captures[screen].alt}
        onLoad={onLoad}
        onError={onError}
      />
    </picture>
  );
}
