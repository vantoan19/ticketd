import { expect, it } from "vitest";
import { regionOf, viewportOf } from "./captures";
import { frameFor, markerIn } from "./framing";
import { stationPin, stops } from "./stops";
import { sourceCrop, viewImages } from "./image-crop";

it.each([false, true])(
  "frames the whole selected control and its pin in the native window (compact %s)",
  (compact) => {
    for (const focus of stops.flatMap((stop) => stop.features)) {
      const frame = frameFor(focus, compact);
      const control = regionOf(focus, compact);
      const viewport = viewportOf(focus.screen, compact);
      const right = frame.left + frame.width;
      const bottom = frame.top + frame.height;
      const label = focus.screen + "/" + focus.region;
      expect(frame.left, label).toBeGreaterThanOrEqual(0);
      expect(frame.top, label).toBeGreaterThanOrEqual(0);
      expect(right, label).toBeLessThanOrEqual(viewport.width);
      expect(bottom, label).toBeLessThanOrEqual(viewport.height);
      expect(control.left, label).toBeGreaterThanOrEqual(frame.left);
      expect(control.top, label).toBeGreaterThanOrEqual(frame.top);
      expect(control.left + control.width, label).toBeLessThanOrEqual(right);
      expect(control.top + control.height, label).toBeLessThanOrEqual(bottom);
      expect(markerIn(control, frame).visible, label).toBe(true);
    }
  },
);

it("gives each numbered landmark its own space on stations that show all pins", () => {
  for (const stop of stops.filter((s) => s.mode === "notes")) {
    const pins = stop.features.map(stationPin);
    for (const [i, a] of pins.entries()) {
      for (const b of pins.slice(i + 1)) {
        const gap = Math.hypot(a.x - b.x, a.y - a.rise - (b.y - b.rise));
        // The largest badge is 20 model units across, plus its outline.
        expect(gap, stop.name).toBeGreaterThan(22);
      }
    }
  }
});

it("offers every native pixel when a dense display requests a larger screenshot", () => {
  for (const compact of [false, true]) {
    for (const feature of stops.flatMap((stop) => stop.features)) {
      const frame = frameFor(feature, compact);
      const sizes = viewImages(feature.screen, "light", frame);
      expect(sizes.at(-1)?.width).toBe(sourceCrop(frame).width);
    }
  }
});
