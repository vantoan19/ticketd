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
/** The last item of each Chat that was in view in a focused window, this session. */
const seenThrough = new Map<string, string>();

/**
 * The last item of a Chat that was in view in a focused window this session. The
 * host keeps only whether the last ended turn is unseen (#365), so a Chat first
 * opened in a session places the marker from that instead (`unseenFrom`).
 */
export const lastSeen = (chatId: string) => seenThrough.get(chatId);

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
 * Notes the first visible `[data-anchor]`, and the last `[data-seen]` item in view
 * when the window has focus.
 */
function note(box: HTMLElement, chatId: string, anchor: { current: Anchor }) {
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
  if (!document.hasFocus()) return;
  let last: string | undefined;
  for (const element of box.querySelectorAll<HTMLElement>("[data-seen]"))
    if (element.getBoundingClientRect().top < bottom)
      last = element.dataset.seen;
  if (last) seenThrough.set(chatId, last);
}

/**
 * Holds the reading position of the transcript: `root` goes on the scrolling
 * element, `content` on the column inside it, `marker` on the New marker.
 * Following is an intent: it stops when the reader scrolls up and resumes only at
 * the bottom, from `follow()` (Jump to latest, or sending), or with End. Otherwise
 * the first visible `[data-anchor]` keeps its offset through every change, since
 * WebKit has no CSS scroll anchoring.
 *
 * On open it goes to the New marker a quarter down when what is new does not fit,
 * else to the bottom; with nothing new, to where the Chat was left this session.
 */
export function useTranscriptScroll(chatId: string) {
  const root = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const marker = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const follows = useRef(true);
  const anchor = useRef<Anchor>(null);
  const opened = useRef("");

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
    note(box, chatId, anchor);
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

  // Every change to the content keeps the bottom, or the anchor, where it was.
  useEffect(() => {
    const box = root.current;
    const column = content.current;
    if (!box || !column || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (follows.current) box.scrollTop = box.scrollHeight;
      else if (anchor.current?.element.isConnected) {
        const { element, offset } = anchor.current;
        const moved =
          element.getBoundingClientRect().top -
          box.getBoundingClientRect().top -
          offset;
        if (moved) box.scrollTop += moved;
      }
      note(box, chatId, anchor);
    });
    observer.observe(column);
    return () => observer.disconnect();
  }, [chatId]);

  const onScroll = () => {
    const box = root.current;
    if (!box) return;
    const bottom = atBottom(box);
    if (bottom !== follows.current) {
      follows.current = bottom;
      setFollowing(bottom);
    }
    note(box, chatId, anchor);
  };

  const follow = () => {
    const box = root.current;
    follows.current = true;
    setFollowing(true);
    if (box) box.scrollTop = box.scrollHeight;
  };

  /**
   * The reader opened or closed `element`: it stays where it is, even at the
   * bottom, so what they clicked does not move away from them.
   */
  const keep = (element: Element) => {
    const box = root.current;
    if (!box) return;
    const offset =
      element.getBoundingClientRect().top - box.getBoundingClientRect().top;
    anchor.current = { element, offset };
    follows.current = false;
    setFollowing(false);
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
