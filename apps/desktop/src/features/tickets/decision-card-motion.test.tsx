// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DecisionCardContent } from "./decision-card-motion";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("a card shrinking above the viewport in an instant keeps the document anchored after the scroll clamps", () => {
  let contentHeight = 140;
  let resize = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(onResize: () => void) {
        resize = onResize;
      }
      observe() {}
      disconnect() {}
    },
  );

  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.classList.contains("ticket-decision-measure"))
        return new DOMRect(0, 0, 0, contentHeight);
      return new DOMRect();
    },
  );
  const { container } = render(
    <div className="detail-scroll" style={{ overflowY: "auto" }}>
      <div data-testid="card">
        <DecisionCardContent state="working">Working</DecisionCardContent>
      </div>
    </div>,
  );
  const scroller = container.querySelector<HTMLElement>(".detail-scroll")!;
  const card = container.querySelector<HTMLElement>('[data-testid="card"]')!;
  const box = card.querySelector<HTMLElement>(".ticket-decision-content")!;
  const cardTop = 350;
  const viewportHeight = 300;
  const otherContentHeight = 720;
  let offset = 500;
  const cardHeight = () => parseFloat(box.style.height);
  const scrollHeight = () => otherContentHeight + cardHeight();
  const clamp = (top: number) =>
    Math.max(0, Math.min(top, scrollHeight() - viewportHeight));
  vi.spyOn(card, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, cardTop - scroller.scrollTop, 0, cardHeight()),
  );
  Object.defineProperties(scroller, {
    clientHeight: { value: viewportHeight },
    scrollHeight: { get: scrollHeight },
    // jsdom has no layout. Keep the browser's clamp, including a clamp
    // that occurs before the component reads its first post-resize offset.
    scrollTop: {
      get: () => (offset = clamp(offset)),
      set: (top: number) => {
        offset = clamp(top);
      },
    },
  });

  expect(card.getBoundingClientRect().bottom).toBe(-10);
  contentHeight = 40;
  resize();
  expect(scroller.scrollTop).toBe(400);
  expect(card.getBoundingClientRect().bottom).toBe(-10);
});
