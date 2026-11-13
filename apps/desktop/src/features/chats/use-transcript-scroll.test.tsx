// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test } from "vitest";
import { useTranscriptScroll } from "@/features/chats/use-transcript-scroll";

/** A ResizeObserver the test triggers, with what each one watches. */
const observers: { callback: ResizeObserverCallback; watched: Element[] }[] =
  [];
window.ResizeObserver = class {
  private entry: (typeof observers)[number];
  constructor(callback: ResizeObserverCallback) {
    this.entry = { callback, watched: [] };
    observers.push(this.entry);
  }
  observe(element: Element) {
    this.entry.watched.push(element);
  }
  unobserve() {}
  disconnect() {
    this.entry.watched = [];
  }
};
/** The browser reports a size change of `element`. */
const resized = (element: Element) =>
  act(() => {
    for (const { callback, watched } of observers)
      if (watched.includes(element))
        callback([], {} as unknown as ResizeObserver);
  });

afterEach(() => {
  cleanup();
  observers.length = 0;
});

let chatCount = 0;
function Reading() {
  const [id] = useState(() => `c${++chatCount}`);
  const { root, content, following, onScroll } = useTranscriptScroll(id);
  return (
    <>
      <div ref={root} data-testid="box" onScroll={onScroll}>
        <div ref={content} />
      </div>
      <p data-testid="state">{following ? "following" : "stopped"}</p>
    </>
  );
}

/**
 * Sizes the scroller as a browser would, which jsdom does not: the offset is
 * clamped to what can scroll.
 */
function size(box: HTMLElement, height: number, content: number) {
  let top = Math.min(box.scrollTop, content - height);
  Object.defineProperties(box, {
    clientHeight: { configurable: true, value: height },
    scrollHeight: { configurable: true, value: content },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(value, content - height));
      },
    },
  });
}

function setup() {
  const view = render(<Reading />);
  const box = view.getByTestId("box");
  const column = box.firstElementChild!;
  const state = () => view.getByTestId("state").textContent;
  return { box, column, state };
}

test("content that grows before the scroll event lands keeps following", () => {
  const { box, column, state } = setup();
  size(box, 200, 1000);
  resized(column);
  expect(box.scrollTop).toBe(800);
  // More arrives before the browser delivers the scroll from that pin: the
  // event sees the end 200px further on, yet nobody scrolled up.
  size(box, 200, 1200);
  fireEvent.scroll(box);
  expect(state()).toBe("following");
  resized(column);
  expect(box.scrollTop).toBe(1000);
});

test("a growing dock that shrinks the scroller keeps the bottom in view", () => {
  const { box, column, state } = setup();
  size(box, 400, 1000);
  resized(column);
  expect(box.scrollTop).toBe(600);
  // The approval dock appears: the scroller loses 200px, the content is the same.
  size(box, 200, 1000);
  resized(box);
  expect(box.scrollTop).toBe(800);
  expect(state()).toBe("following");
});

test("scrolling up still stops following, and the bottom resumes it", () => {
  const { box, column, state } = setup();
  size(box, 200, 1000);
  resized(column);
  fireEvent.scroll(box);
  box.scrollTop = 500;
  fireEvent.scroll(box);
  expect(state()).toBe("stopped");
  // While stopped, growth leaves the reader where they are.
  size(box, 200, 1400);
  resized(column);
  expect(box.scrollTop).toBe(500);
  box.scrollTop = 1200;
  fireEvent.scroll(box);
  expect(state()).toBe("following");
  resized(column);
  expect(box.scrollTop).toBe(1200);
});
