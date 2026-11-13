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
function Reading({ chatId }: { chatId?: string }) {
  const [id] = useState(() => chatId ?? `c${++chatCount}`);
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
  let top = Math.max(0, Math.min(box.scrollTop, content - height));
  Object.defineProperties(box, {
    clientHeight: { configurable: true, value: height },
    scrollHeight: { configurable: true, value: content },
    scrollTop: {
      configurable: true,
      // A detached element reads 0, as WebKit and Chromium do.
      get: () => (box.isConnected ? top : 0),
      set: (value: number) => {
        top = Math.max(0, Math.min(value, content - height));
      },
    },
  });
}

function setup(chatId?: string) {
  const view = render(<Reading {...(chatId && { chatId })} />);
  const box = view.getByTestId("box");
  const column = box.firstElementChild!;
  const state = () => view.getByTestId("state").textContent;
  return { box, column, state, view };
}

/** The reader turns the wheel up, then the browser scrolls. */
function wheelUp(box: HTMLElement, to: number) {
  fireEvent.wheel(box, { deltaY: -(box.scrollTop - to) });
  box.scrollTop = to;
  fireEvent.scroll(box);
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
  wheelUp(box, 500);
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

// LIVE-1: answering an approval removes its card; the scroller grows, the
// browser clamps the offset, and the next step lands before that clamp's scroll
// event. The smaller offset is not the reader leaving.
test("a dock that shrinks, then content that arrives, keeps following", () => {
  const { box, column, state } = setup();
  size(box, 200, 1000);
  resized(column);
  expect(box.scrollTop).toBe(800);
  size(box, 300, 1000);
  expect(box.scrollTop).toBe(700);
  size(box, 300, 1100);
  fireEvent.scroll(box);
  expect(state()).toBe("following");
  resized(box);
  resized(column);
  expect(box.scrollTop).toBe(800);
});

// LIVE-2: the turn folds (the content shrinks by its steps), the files and
// records rows arrive, then the clamp's scroll event: still following, so the
// end of the answer stays in view.
test("the fold shrinking the turn, then rows that arrive, keeps following", () => {
  const { box, column, state } = setup();
  size(box, 500, 4000);
  resized(column);
  expect(box.scrollTop).toBe(3500);
  size(box, 500, 1000);
  size(box, 500, 1100);
  fireEvent.scroll(box);
  expect(state()).toBe("following");
  resized(column);
  expect(box.scrollTop).toBe(600);
});

// MOTION-18: a small wheel up inside the bottom band is the reader leaving,
// and the next token does not snap them back.
test("a small wheel up stops following", () => {
  const { box, column, state } = setup();
  size(box, 200, 1000);
  resized(column);
  fireEvent.scroll(box);
  wheelUp(box, 796);
  expect(state()).toBe("stopped");
  size(box, 200, 1040);
  resized(column);
  expect(box.scrollTop).toBe(796);
});

// MOTION-1: the position is kept while reading, not read from a detached
// scroller on the way out.
test("reopening a Chat restores where the reader left it", () => {
  const first = setup("kept");
  size(first.box, 200, 1000);
  resized(first.column);
  wheelUp(first.box, 400);
  first.view.unmount();
  // The new scroller is not sized yet when it opens: record what it is given.
  const given: number[] = [];
  const own = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  Object.defineProperty(HTMLDivElement.prototype, "scrollTop", {
    configurable: true,
    get: () => given.at(-1) ?? 0,
    set: (value: number) => given.push(value),
  });
  try {
    render(<Reading chatId="kept" />);
  } finally {
    delete (HTMLDivElement.prototype as { scrollTop?: number }).scrollTop;
    if (own) Object.defineProperty(Element.prototype, "scrollTop", own);
  }
  expect(given[0]).toBe(400);
});

function Folding({ folded }: { folded: boolean }) {
  const { root, content, onScroll } = useTranscriptScroll("folding");
  return (
    <div ref={root} data-testid="box" onScroll={onScroll}>
      <div ref={content}>
        <div data-anchor="">
          {!folded && <div data-anchor="" data-testid="steps" />}
          {!folded && <div data-anchor="answer" data-testid="answer" />}
        </div>
        {folded && <div data-anchor="answer" data-testid="answer" />}
      </div>
    </div>
  );
}

// LIVE-2, read from further up: the fold remounts the answer outside the
// turn's rows. The answer the reader is in stays where it was on screen.
test("a reader in the answer keeps their place when the turn folds", () => {
  let answerTop = 300;
  const rect = (top: number, height: number) =>
    ({ top, bottom: top + height }) as DOMRect;
  const own = Element.prototype.getBoundingClientRect;
  const view = render(<Folding folded={false} />);
  const box = view.getByTestId("box");
  Element.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this === box) return rect(0, 200);
    if (this.dataset.testid === "steps") return rect(-box.scrollTop, 300);
    if (this.dataset.testid === "answer")
      return rect(answerTop - box.scrollTop, 900);
    return rect(-box.scrollTop, 1200);
  };
  try {
    size(box, 200, 1200);
    resized(box.firstElementChild!);
    wheelUp(box, 500);
    // The steps above the answer fold away: the answer moves up 250px.
    view.rerender(<Folding folded />);
    answerTop = 50;
    size(box, 200, 950);
    resized(box.firstElementChild!);
    expect(box.scrollTop).toBe(250);
  } finally {
    Element.prototype.getBoundingClientRect = own;
  }
});
