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

type Anchor = { element: Element; offset: number } | null;

const atBottom = (box: HTMLElement) =>
  box.scrollHeight - box.scrollTop - box.clientHeight <= BOTTOM;

/**
 * Notes the first visible `[data-anchor]`, and returns the last `[data-seen]` item
 * in view when the window has focus.
 */
function note(box: HTMLElement, anchor: { current: Anchor }) {
  const top = box.getBoundingClientRect().top;
  const bottom = top + box.clientHeight;
  anchor.current = null;
  for (const element of box.querySelectorAll("[data-anchor]")) {
    const rect = element.getBoundingClientRect();
    if (rect.bottom > top) {
      anchor.current = { element, offset: rect.top - top };
      break;
    }
  }
  if (!document.hasFocus()) return undefined;
  let last: string | undefined;
  for (const element of box.querySelectorAll<HTMLElement>("[data-seen]"))
    if (element.getBoundingClientRect().top < bottom)
      last = element.dataset.seen;
  return last;
}

/**
 * Holds the reading position of the transcript: `root` goes on the scrolling
 * element, `content` on the column inside it, `marker` on the New marker.
 * Following is an intent: it stops when the reader scrolls up and resumes only at
 * the bottom, from `follow()` (Jump to latest, or sending), or with End. A scroll
 * event arrives a frame after the scroll, so content that grew meanwhile must not
 * read as the reader leaving the end: only a smaller offset stops following.
 * Both the content and the scroller are watched, so a dock or composer that grows
 * keeps the end in view too. Otherwise
 * the first visible `[data-anchor]` keeps its offset through every change, since
 * WebKit has no CSS scroll anchoring.
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
  const opened = useRef("");
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
    read(box);
    // The opening position decides whether the control shows from the first paint.
    setFollowing(follows.current);
  }, [chatId]);

  // Leaving keeps where the Chat was, for when it reopens this session.
  useEffect(() => {
    const box = root.current;
    return () => {
      if (box) positions.set(chatId, follows.current ? "end" : box.scrollTop);
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
      } else if (anchor.current?.element.isConnected) {
        const { element, offset } = anchor.current;
        const moved =
          element.getBoundingClientRect().top -
          box.getBoundingClientRect().top -
          offset;
        if (moved) box.scrollTop += moved;
      }
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
    const up = top < lastTop.current - 1;
    lastTop.current = top;
    // Following stops only when the reader moves up; it resumes at the bottom.
    const next = atBottom(box) || (follows.current && !up);
    if (next !== follows.current) {
      follows.current = next;
      setFollowing(next);
    }
    if (next && !atBottom(box)) {
      box.scrollTop = box.scrollHeight;
      lastTop.current = box.scrollTop;
    }
    read(box);
  };

  const follow = () => {
    const box = root.current;
    follows.current = true;
    setFollowing(true);
    if (box) {
      box.scrollTop = box.scrollHeight;
      lastTop.current = box.scrollTop;
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
    anchor.current = { element, offset };
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
