import type { Screen } from "./captures.ts";
import type { Frame } from "./framing.ts";

/** Screen coordinates are CSS pixels. The source captures have two device pixels per CSS pixel. */
export function sourceCrop(frame: Frame) {
  const left = Math.round(frame.left * 2);
  const top = Math.round(frame.top * 2);
  return {
    left,
    top,
    width: Math.round((frame.left + frame.width) * 2) - left,
    height: Math.round((frame.top + frame.height) * 2) - top,
  };
}
export type Crop = ReturnType<typeof sourceCrop>;
export type ImageTheme = "light" | "dark";

export function captureFile(
  screen: Screen,
  theme: string,
  width: number,
  compact: boolean,
) {
  return `${screen}${compact ? "-compact" : ""}-${theme}-${width}.webp`;
}

export function viewImages(screen: Screen, theme: ImageTheme, frame: Frame) {
  const crop = sourceCrop(frame);
  // Dense displays can use every captured pixel without upscaling the source.
  const widths = [400, 800, 1600].filter((width) => width < crop.width);
  widths.push(crop.width);
  const prefix =
    "/screens/views/" +
    [
      screen + (frame.compact ? "-compact" : ""),
      theme,
      crop.left,
      crop.top,
      crop.width,
      crop.height,
    ].join("-");
  return widths.map((width) => ({
    url: prefix + "-" + width + ".webp",
    width,
    crop,
  }));
}
