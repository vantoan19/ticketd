import {
  captures,
  regionOf,
  viewportOf,
  type Focus,
  type Region,
} from "./captures.ts";

export interface Frame {
  compact: boolean;
  left: number;
  top: number;
  width: number;
  height: number;
  aspect: number;
}
const clamp = (n: number, low: number, high: number) =>
  Math.min(high, Math.max(low, n));

/** The actual desktop controls supply the camera bounds. A phone gets the whole
 * selected card or message; an Automation keeps every branch of the rule in view. */
export function frameFor(focus: Focus, phone: boolean): Frame {
  const viewport = viewportOf(focus.screen, phone);
  const region = regionOf(focus, phone);
  const capture = captures[focus.screen];
  const diagram = capture.frame === "diagram";
  // All three rule choices share a frame so the station stays still as they
  // change. The narrow window needs room for the weekly rule's third node.
  const aspect = diagram ? (phone ? 1.2 : 1.76) : phone ? 1.63 : 2.15;
  let left: number, top: number, width: number;
  if (diagram) {
    const padding = phone ? 22 : 36;
    width = Math.min(
      viewport.width,
      viewport.height * aspect,
      Math.max(
        phone ? 340 : 550,
        region.width + padding * 2,
        (region.height + padding * 2) * aspect,
      ),
    );
    left = region.left + region.width / 2 - width / 2;
    top = region.top + region.height / 2 - width / aspect / 2;
  } else if (phone) {
    width = Math.min(
      viewport.width,
      Math.max(capture.phoneWidth, region.width + 36),
    );
    left = clamp(
      region.left - width * 0.13,
      region.left + region.width + 12 - width,
      region.left - 12,
    );
    top = region.top + region.height / 2 - (width / aspect) * 0.48;
  } else {
    // Keep the whole card, message or control in frame, including its border.
    [left, top, width] = capture.frame;
    const inset = 18;
    left = clamp(
      left,
      region.left + region.width + inset - width,
      region.left - inset,
    );
    top = clamp(
      top,
      region.top + region.height + inset - width / aspect,
      region.top - inset,
    );
  }
  width = Math.min(width, viewport.width, viewport.height * aspect);
  const height = width / aspect;
  return {
    compact: phone,
    left: clamp(left, 0, viewport.width - width),
    top: clamp(top, 0, viewport.height - height),
    width,
    height,
    aspect,
  };
}

export function markerIn(region: Region, frame: Frame) {
  const x = (region.x - frame.left) / frame.width,
    y = (region.y - frame.top) / frame.height;
  return {
    x,
    y,
    visible: x >= 0.012 && x <= 0.988 && y >= 0.018 && y <= 0.982,
    offsetX: x < 0.07 ? "25px" : "-25px",
    offsetY: y < 0.1 ? "17px" : "-17px",
  };
}
