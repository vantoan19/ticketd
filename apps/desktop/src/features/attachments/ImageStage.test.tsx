// @vitest-environment jsdom
import { useRef, type KeyboardEvent } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { fitScale } from "./image-layout";
import { ImageStage } from "./ImageStage";
import type { Attachment } from "@/lib/api/attachments";

afterEach(cleanup);

const file: Attachment = {
  id: "shot-1",
  display_name: "refund-after-fix.png",
  original_filename: "refund-after-fix.png",
  size_bytes: 4096,
  kind: "local_snapshot",
  locator: "shot-1/bytes/refund-after-fix.png",
};

function Stage() {
  const scroller = useRef<HTMLDivElement>(null);
  const keys = useRef<((event: KeyboardEvent) => void) | null>(null);
  return (
    <div
      ref={scroller}
      data-testid="stage"
      tabIndex={-1}
      onKeyDown={(event) => keys.current?.(event)}
    >
      <ImageStage
        file={file}
        url="attachment-media://localhost/w/shot-1"
        onError={() => {}}
        scrollerRef={scroller}
        keysRef={keys}
      />
    </div>
  );
}

/** A 1600 x 900 picture in a stage with room for 1000 x 400 around it. */
function loaded() {
  const view = render(<Stage />);
  const stage = screen.getByTestId("stage");
  // 1000 wide, 400 tall inside the 20px sides, the 20px top and the 72px under it.
  Object.defineProperty(stage, "clientWidth", { value: 1040 });
  Object.defineProperty(stage, "clientHeight", { value: 492 });
  const image = screen.getByRole("img", { name: file.display_name });
  Object.defineProperty(image, "naturalWidth", { value: 1600 });
  Object.defineProperty(image, "naturalHeight", { value: 900 });
  // The stage measures itself when it mounts; a resize makes it measure again.
  window.dispatchEvent(new Event("resize"));
  fireEvent.load(image);
  return { view, stage, image };
}
const zoomOf = () => screen.getByText(/%$/).textContent;

test("fit works out the scale that keeps a picture whole and never enlarges it", () => {
  const room = { width: 1000, height: 400 };
  expect(fitScale({ width: 1600, height: 900 }, room)).toBeCloseTo(400 / 900);
  expect(fitScale({ width: 400, height: 200 }, room)).toBe(1);
  // A tiny picture is drawn at least 128px on its short side.
  expect(fitScale({ width: 32, height: 32 }, room)).toBe(4);
  // Before the stage is measured the picture is shown at its own size.
  expect(
    fitScale({ width: 400, height: 100 }, { width: -40, height: -92 }),
  ).toBe(1);
});

test("a picture sits above a zoom bar, and Fit is pressed until it is zoomed", () => {
  loaded();
  const group = screen.getByRole("group", { name: "Zoom" });
  expect(group).toBeTruthy();
  expect(screen.getByRole("button", { name: "Zoom out" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Zoom in" })).toBeTruthy();
  const fit = screen.getByRole("button", { name: "Fit" });
  expect(fit.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  expect(fit.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(fit);
  expect(fit.getAttribute("aria-pressed")).toBe("true");
});

test("clicking the picture toggles between Fit and 100%", () => {
  const { image } = loaded();
  const fit = screen.getByRole("button", { name: "Fit" });
  fireEvent.click(image);
  expect(zoomOf()).toBe("100%");
  expect(image.style.width).toBe("1600px");
  expect(fit.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(image);
  expect(fit.getAttribute("aria-pressed")).toBe("true");
});

test("+ - and 0 zoom and fit while the stage has focus, but not inside a field", () => {
  const { stage, image } = loaded();
  const start = zoomOf();
  fireEvent.keyDown(stage, { key: "+" });
  expect(zoomOf()).not.toBe(start);
  const zoomed = Number.parseInt(zoomOf()!, 10);
  expect(zoomed).toBeGreaterThan(Number.parseInt(start!, 10));
  fireEvent.keyDown(stage, { key: "-" });
  fireEvent.keyDown(stage, { key: "-" });
  expect(Number.parseInt(zoomOf()!, 10)).toBeLessThan(zoomed);
  fireEvent.keyDown(stage, { key: "0" });
  expect(
    screen.getByRole("button", { name: "Fit" }).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(zoomOf()).toBe(start);
  // ⌘+ stays the app's zoom.
  fireEvent.keyDown(stage, { key: "+", metaKey: true });
  expect(zoomOf()).toBe(start);
  expect(image.style.width).not.toBe("");
});
