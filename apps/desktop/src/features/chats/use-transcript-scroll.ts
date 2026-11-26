import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/** Within this many pixels of the end counts as being at the bottom. */
const BOTTOM = 8;

/** Where a Chat was left this session: following, or at a scroll offset. */
const positions = new Map<string, number | "end">();

/**
 * What rows ask of the reading position: whether the reader follows the end, and
 * to keep a row in place when the reader opens or closes it.
 */
export type Reading = {
  follows: () => boolean;
  keep: (element: Element) => void;
};
export const ReadingContext = createContext<Reading>({
  follows: () => true,
  keep: () => {},
});
export const useReading = () => useContext(ReadingContext);

type Anchor = { element: Element; offset: number; key: string } | null;

const atBottom = (box: HTMLElement) =>
  box.scrollHeight - box.scrollTop - box.clientHeight <= BOTTOM;

/**
 * Notes the innermost first visible `[data-anchor]`, and returns the last
 * `[data-seen]` item in view when the window has focus. An anchor with a value
 * (an item id) is found again if its row is remounted, as a turn's answer is
 * when the turn folds.
 */
function note(box: HTMLElement, anchor: { current: Anchor }) {
  const top = box.getBoundingClientRect().top;
  const bottom = top + box.clientHeight;
  anchor.current = null;
  for (const element of box.querySelectorAll<HTMLElement>("[data-anchor]")) {
    // Anchors come in document order: past the chosen one's subtree, stop.
    if (anchor.current && !anchor.current.element.contains(element)) break;
    const rect = element.getBoundingClientRect();
    if (rect.bottom > top)
      anchor.current = {
        element,
        offset: rect.top - top,
        key: element.dataset.anchor ?? "",
      };
  }
  if (!document.hasFocus()) return undefined;
  let last: string | undefined;
  for (const element of box.querySelectorAll<HTMLElement>("[data-seen]"))
    if (element.getBoundingClientRect().top < bottom)
      last = element.dataset.seen;
  return last;
}

/** The anchor's element, or the row that replaced it under the same key. */
function anchored(box: HTMLElement, anchor: NonNullable<Anchor>) {
  if (anchor.element.isConnected) return anchor.element;
  if (!anchor.key) return null;
  for (const element of box.querySelectorAll<HTMLElement>("[data-anchor]"))
    if (element.dataset.anchor === anchor.key) return element;
  return null;
}

/** Keeps where the Chat is now, for when it reopens this session. */
const remember = (chatId: string, following: boolean, box: HTMLElement) =>
  positions.set(chatId, following ? "end" : box.scrollTop);

/** How long after the reader's wheel, touch or key a scroll counts as theirs. */
const INPUT_MS = 500;

/**
 * Holds the reading position of the transcript: `root` goes on the scrolling
 * element, `content` on the column inside it, `marker` on the New marker.
 * Following is an intent: it stops only when the reader scrolls up (wheel, touch,
 * keys or the scrollbar) and resumes at the bottom, from `follow()` (Jump to
 * latest, sending, answering), or with End. A smaller offset alone is not the
 * reader: content that shrinks (a dock card leaving, a turn folding) clamps the
 * offset, and its scroll event lands a frame later, often after more content
 * arrived, so it reads as "up and not at the bottom".
 * Both the content and the scroller are watched, so a dock or composer that grows
 * keeps the end in view too. Otherwise
 * the first visible `[data-anchor]` keeps its offset through every change, since
 * WebKit has no CSS scroll anchoring.
 *
 * The position is kept as it changes, so reopening the Chat this session
 * restores it (a scroller read on the way out is already detached).
 *
 * On open it goes to the New marker a quarter down when what is new does not fit,
 * else to the bottom; with nothing new, to where the Chat was left this session.
 * `onRead` is told the last item in view in a focused window as it changes; the
 * host keeps it with the Chat (#365) and it only moves forward there.
 */
export function useTranscriptScroll(
  chatId: string,
  onRead: (itemId: string) => void = () => {},
) {
  const root = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const marker = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const follows = useRef(true);
  const anchor = useRef<Anchor>(null);
  // The offset after the last scroll, ours or the reader's.
  const lastTop = useRef(0);
  // The scroller's height at the last scroll: a taller one (the Jump strip
  // closing at the end) clamps the offset, which is not the reader.
  const lastHeight = useRef(0);
  const opened = useRef("");
  // When the reader last used the wheel, touch or keys here, or holds the
  // pointer down (dragging the scrollbar or a selection).
  const input = useRef(-Infinity);
  const pressed = useRef(false);
  const theirs = () =>
    pressed.current || performance.now() - input.current < INPUT_MS;
  const setFollows = (next: boolean) => {
    if (next === follows.current) return;
    follows.current = next;
    setFollowing(next);
  };
  const told = useRef<string | undefined>(undefined);
  // The latest `onRead`, for scroll and resize callbacks that outlive a render.
  const onReadRef = useRef(onRead);
  useLayoutEffect(() => {
    onReadRef.current = onRead;
  });
  const read = (box: HTMLElement) => {
    const last = note(box, anchor);
    if (last && last !== told.current) {
      told.current = last;
      onReadRef.current(last);
    }
  };

  // The opening position, before the first paint. The marker is placed once and
  // stays until the reader sends or leaves, so this runs only when the Chat opens.
  useLayoutEffect(() => {
    const box = root.current;
    if (!box || opened.current === chatId) return;
    opened.current = chatId;
    const saved = positions.get(chatId);
    const line = marker.current;
    if (line) {
      const lineTop =
        line.getBoundingClientRect().top -
        box.getBoundingClientRect().top +
        box.scrollTop;
      if (box.scrollHeight - lineTop > box.clientHeight)
        box.scrollTop = lineTop - box.clientHeight / 4;
      else box.scrollTop = box.scrollHeight;
    } else if (typeof saved === "number") box.scrollTop = saved;
    else box.scrollTop = box.scrollHeight;
    follows.current = atBottom(box);
    lastTop.current = box.scrollTop;
    lastHeight.current = box.clientHeight;
    remember(chatId, follows.current, box);
    read(box);
    // The opening position decides whether the control shows from the first paint.
    setFollowing(follows.current);
  }, [chatId]);

  // The reader's own scrolling: the wheel up leaves at once, even inside the
  // bottom band; touch, keys and a held pointer mark the next scroll as theirs.
  useEffect(() => {
    const box = root.current;
    if (!box) return;
    const mark = () => {
      input.current = performance.now();
    };
    const wheel = (event: WheelEvent) => {
      mark();
      if (event.deltaY < 0 && box.scrollTop > 0 && follows.current) {
        follows.current = false;
        setFollowing(false);
        positions.set(chatId, box.scrollTop);
      }
    };
    const press = () => {
      pressed.current = true;
    };
    const release = () => {
      if (!pressed.current) return;
      pressed.current = false;
      mark();
    };
    box.addEventListener("wheel", wheel, { passive: true });
    box.addEventListener("touchmove", mark, { passive: true });
    box.addEventListener("keydown", mark);
    box.addEventListener("pointerdown", press);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      box.removeEventListener("wheel", wheel);
      box.removeEventListener("touchmove", mark);
      box.removeEventListener("keydown", mark);
      box.removeEventListener("pointerdown", press);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, [chatId]);

  // Every change to the content, or to the scroller's own height, keeps the
  // bottom, or the anchor, where it was.
  useEffect(() => {
    const box = root.current;
    const column = content.current;
    if (!box || !column || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (follows.current) {
        box.scrollTop = box.scrollHeight;
        lastTop.current = box.scrollTop;
      } else if (anchor.current) {
        const element = anchored(box, anchor.current);
        const moved = element
          ? element.getBoundingClientRect().top -
            box.getBoundingClientRect().top -
            anchor.current.offset
          : 0;
        if (moved) box.scrollTop += moved;
        lastTop.current = box.scrollTop;
      }
      remember(chatId, follows.current, box);
      read(box);
    });
    observer.observe(column);
    observer.observe(box);
    return () => observer.disconnect();
  }, [chatId]);

  const onScroll = () => {
    const box = root.current;
    if (!box) return;
    const top = box.scrollTop;
    const grew = box.clientHeight > lastHeight.current;
    lastHeight.current = box.clientHeight;
    const up = top < lastTop.current - 1 && !grew;
    lastTop.current = top;
    // Following stops only when the reader moves up; it resumes at the bottom.
    if (follows.current) {
      if (up && theirs()) setFollows(false);
    } else if (!up && atBottom(box)) setFollows(true);
    if (follows.current && !atBottom(box)) {
      box.scrollTop = box.scrollHeight;
      lastTop.current = box.scrollTop;
    }
    remember(chatId, follows.current, box);
    read(box);
  };

  const follow = () => {
    const box = root.current;
    setFollows(true);
    if (box) {
      box.scrollTop = box.scrollHeight;
      lastTop.current = box.scrollTop;
      remember(chatId, follows.current, box);
    }
  };

  /**
   * The reader opened or closed `element`: while they read further up it stays
   * where it is, so what they clicked does not move away from them. At the
   * bottom the transcript keeps following; only scrolling up stops that.
   */
  const keep = (element: Element) => {
    const box = root.current;
    if (!box || follows.current) return;
    const offset =
      element.getBoundingClientRect().top - box.getBoundingClientRect().top;
    anchor.current = { element, offset, key: "" };
  };

  return {
    root,
    content,
    marker,
    following,
    reading: { follows: () => follows.current, keep },
    follow,
    onScroll,
  };
}
