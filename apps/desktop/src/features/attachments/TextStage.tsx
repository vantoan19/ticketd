import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ChevronDown,
  ChevronUp,
  Info,
  Search,
  WrapText,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { FailureState } from "@/components/ui/failure-alert";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { attachments, type Attachment } from "@/lib/api/attachments";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { matchesShortcut } from "@/lib/shortcuts";
import { setPreference, usePreferences } from "@/lib/preferences";
import { formatSize } from "./format-size";
import type { StageKeys } from "./PdfStage";
import { ViewBar, ViewBarGroup } from "./ViewBar";
import {
  BLOCK_LINES,
  HANG,
  LINE_HEIGHT,
  MAX_LINES,
  blockAt,
  blockTops,
  estimateBlocks,
  findMatches,
  firstMatchFrom,
  lastLines,
  parseLines,
  rowsOf,
  searchIndex,
  selectionText,
  type Match,
  type Position,
  type SearchIndex,
} from "./text-lines";

type Scope = { total_bytes: number; shown_bytes: number; partial: boolean };
type Loaded =
  | { key: string; index: SearchIndex; dropped: number; firstLine: number }
  | { key: string; failure: FailureDescription };

/** The line number column, the right padding, and the line above a partial log. */
const GUTTER = 64;
/** The space around a line number, inside the gutter: 8px before it and 12px after. */
const GUTTER_PADDING = 20;
const RIGHT_PADDING = 16;
const SCOPE_LINE = 36;
/** Room under the last line for the view bar. */
const BAR_CLEARANCE = 72;
const PROBE_CHARS = 64;
const FALLBACK_CHAR_WIDTH = 7.8;

/**
 * A log or text file (DESIGN.md section 10): every line, numbered, in a stage that
 * draws only the lines near the view, with Wrap lines and Find in the view bar.
 * The text is one bounded read of the stored snapshot, whole up to 20 MB and
 * otherwise its end, with a line above it that says which.
 */
export function TextStage({
  workspace,
  file,
  scope,
  attempt,
  onRetry,
  scrollerRef,
  keysRef,
  reachable,
}: {
  workspace: string;
  file: Attachment;
  scope: Scope;
  /** Bumped by Retry: the text is read again. */
  attempt: number;
  onRetry: () => void;
  /** The scrolling stage this draws into. */
  scrollerRef: RefObject<HTMLElement | null>;
  keysRef: StageKeys;
  /** The text takes a Tab stop itself (where the stage is not already one). */
  reachable: boolean;
}) {
  const key = `${workspace}/${file.id}/${attempt}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    let active = true;
    // A log's end keeps the file's own numbers: core says how many lines it cut.
    Promise.all([
      attachments.text(workspace, file.id),
      scope.partial ? attachments.textFirstLine(workspace, file.id) : 1,
    ]).then(
      ([text, firstLine]) => {
        if (!active) return;
        const { text: shown, dropped } = lastLines(text, MAX_LINES);
        setLoaded({
          key,
          index: searchIndex(shown, parseLines(shown)),
          dropped,
          firstLine,
        });
      },
      (reason: unknown) => {
        if (active)
          setLoaded({ key, failure: describeFailure(reason, "read the file") });
      },
    );
    return () => {
      active = false;
    };
  }, [key, workspace, file.id, scope.partial]);
  const current = loaded?.key === key ? loaded : null;
  if (!current)
    return (
      <div
        role="status"
        aria-label="Loading preview"
        className="attachment-preview-loading"
      >
        <Skeleton className="h-full w-full" />
      </div>
    );
  if ("failure" in current)
    return <FailureState failure={current.failure} onRetry={onRetry} />;
  return (
    <TextLines
      key={key}
      name={file.display_name}
      index={current.index}
      dropped={current.dropped}
      firstLine={current.firstLine}
      scope={scope}
      scrollerRef={scrollerRef}
      keysRef={keysRef}
      reachable={reachable}
    />
  );
}

function TextLines({
  name,
  index,
  dropped,
  firstLine,
  scope,
  scrollerRef,
  keysRef,
  reachable,
}: {
  name: string;
  index: SearchIndex;
  /** Lines before the first one shown, when the file has too many to draw. */
  dropped: number;
  /** The file's own number of the first line of the text (after a long log's cut). */
  firstLine: number;
  scope: Scope;
  scrollerRef: RefObject<HTMLElement | null>;
  keysRef: StageKeys;
  reachable: boolean;
}) {
  const { lines } = index.parsed;
  const wrap = usePreferences().attachmentWrap;
  const listRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [charWidth, setCharWidth] = useState(FALLBACK_CHAR_WIDTH);
  // 64px, wider when the last number (a long log's end can reach millions) needs it.
  const gutter = Math.max(
    GUTTER,
    Math.ceil(String(firstLine + dropped + lines.length).length * charWidth) +
      GUTTER_PADDING,
  );
  const note = scopeNote(scope, lines.length, dropped);
  const origin = note ? SCOPE_LINE : 0;

  // The stage's size, its scroll position, and the width of one character.
  useLayoutEffect(() => {
    const stage = scrollerRef.current;
    if (!stage) return;
    const measure = () => {
      setSize({ width: stage.clientWidth, height: stage.clientHeight });
      const probe = probeRef.current?.getBoundingClientRect().width ?? 0;
      if (probe > 0) setCharWidth(probe / PROBE_CHARS);
    };
    measure();
    let frame = 0;
    const onScroll = () => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          setScrollTop(stage.scrollTop);
        });
    };
    stage.addEventListener("scroll", onScroll, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(stage);
    // The mono font may arrive after the first measure.
    void document.fonts?.ready.then(measure);
    return () => {
      stage.removeEventListener("scroll", onScroll);
      observer?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scrollerRef]);

  // Heights: an estimate for every block, replaced by the real height of those drawn.
  const columns = Math.max(
    20,
    Math.floor((size.width - gutter - RIGHT_PADDING) / charWidth),
  );
  const layoutKey = `${wrap}/${columns}`;
  const estimates = useMemo(
    () => estimateBlocks(lines, columns, wrap),
    [lines, columns, wrap],
  );
  const measured = useRef({ key: "", heights: new Map<number, number>() });
  const [version, remeasured] = useReducer((count: number) => count + 1, 0);
  const heights = useMemo(() => {
    if (measured.current.key !== layoutKey)
      measured.current = { key: layoutKey, heights: new Map() };
    const result = Float64Array.from(estimates);
    for (const [block, height] of measured.current.heights)
      result[block] = height;
    return result;
    // `version` is what says the measured heights changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estimates, layoutKey, version]);
  const tops = useMemo(() => blockTops(heights), [heights]);

  // Find: the query is kept when the field closes; matches show while it is open.
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  // Which match is current belongs to one set of matches; a new set starts at its first.
  const [cursor, setCursor] = useState<{
    of: readonly Match[] | null;
    index: number;
  }>({ of: null, index: 0 });
  const deferred = useDeferredValue(query);
  const found = useMemo(
    () =>
      finding
        ? findMatches(index, deferred)
        : { matches: [] as Match[], capped: false },
    [finding, index, deferred],
  );
  const { matches } = found;
  const active = matches.length
    ? cursor.of === matches
      ? cursor.index
      : 0
    : -1;
  const reveal = useRef<Match | null>(null);
  const keep = useRef<Match | null>(null);

  function step(direction: 1 | -1) {
    if (!matches.length) return;
    const next = (active + direction + matches.length) % matches.length;
    setCursor({ of: matches, index: next });
    showMatch(matches[next]!);
  }
  /** Scroll so the match is in view: by estimate now, then exactly once it is drawn. */
  function showMatch(match: Match) {
    reveal.current = match;
    const stage = scrollerRef.current;
    if (!stage) return;
    const block = Math.floor(match.line / BLOCK_LINES);
    let offset = origin + tops[block]!;
    for (let line = block * BLOCK_LINES; line < match.line; line++)
      offset += rowsOf(lines[line]!.length, columns, wrap) * LINE_HEIGHT;
    const height = size.height || 600;
    if (
      offset < stage.scrollTop + SCOPE_LINE ||
      offset > stage.scrollTop + height - BAR_CLEARANCE
    )
      stage.scrollTop = Math.max(0, offset - height / 2);
  }
  // A new query scrolls to its first match.
  useEffect(() => {
    const first = found.matches[0];
    if (first) showMatch(first);
    // Only a new set of matches moves the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [found]);

  function openFind() {
    if (finding) {
      inputRef.current?.focus();
      inputRef.current?.select();
      return;
    }
    const selected = window.getSelection()?.toString() ?? "";
    if (selected && selected.length <= 200 && !/[\r\n]/.test(selected))
      setQuery(selected);
    setFinding(true);
  }
  useEffect(() => {
    if (!finding) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [finding]);
  function closeFind() {
    // The current match stays selected, so it can be copied.
    keep.current = active >= 0 ? matches[active]! : null;
    setFinding(false);
    scrollerRef.current?.focus({ preventScroll: true });
  }
  useLayoutEffect(() => {
    const match = keep.current;
    if (finding || !match) return;
    keep.current = null;
    const text = listRef.current?.querySelector(
      `[data-line="${match.line}"] .attachment-text-content`,
    )?.firstChild;
    if (!text) return;
    const range = document.createRange();
    range.setStart(text, match.start);
    range.setEnd(text, match.end);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, [finding]);

  const toggleWrap = useCallback(
    () => setPreference("attachmentWrap", !wrap),
    [wrap],
  );
  useEffect(() => {
    // The stage hands every key it hears to the format showing in it.
    keysRef.current = (event: KeyboardEvent) => {
      if (event.altKey) return;
      const inField =
        event.target instanceof HTMLElement &&
        event.target.closest("input, textarea, select, [contenteditable]");
      if (matchesShortcut(event, "attachments-find")) {
        if (inField && event.key === "/") return;
        event.preventDefault();
        openFind();
      } else if (
        !inField &&
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        event.key.toLowerCase() === "a"
      ) {
        // Select all means the whole log, not the page behind it; only the drawn rows exist.
        event.preventDefault();
        if (listRef.current)
          window.getSelection()?.selectAllChildren(listRef.current);
      } else if (inField || event.ctrlKey || event.metaKey) return;
      else if (matchesShortcut(event, "attachments-wrap")) {
        event.preventDefault();
        toggleWrap();
      }
    };
    return () => {
      keysRef.current = null;
    };
    // `openFind` reads the current find state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysRef, toggleWrap, finding]);

  // The block range to draw: the view, and a screen of lines either side.
  const relative = Math.max(0, scrollTop - origin);
  const viewHeight = size.height || 600;
  const first = blockAt(tops, relative - viewHeight);
  const last = blockAt(tops, relative + 2 * viewHeight);
  const blocks = heights.length;

  // After drawing: take the real height of each block, keeping the view still, and
  // finish a scroll to a match.
  useLayoutEffect(() => {
    const list = listRef.current;
    const stage = scrollerRef.current;
    if (!list || !stage) return;
    const anchor = blockAt(tops, relative);
    let shift = 0;
    let changed = false;
    for (const element of list.querySelectorAll<HTMLElement>("[data-block]")) {
      const block = Number(element.dataset["block"]);
      const height = element.offsetHeight;
      if (height === 0 || Math.abs(height - heights[block]!) < 1) continue;
      measured.current.heights.set(block, height);
      if (block < anchor) shift += height - heights[block]!;
      changed = true;
    }
    if (changed) {
      if (shift) stage.scrollTop += shift;
      remeasured();
      return;
    }
    const target = reveal.current
      ? list.querySelector<HTMLElement>("[data-current]")
      : null;
    if (target) {
      reveal.current = null;
      const stageBox = stage.getBoundingClientRect();
      const box = target.getBoundingClientRect();
      const top = box.top - stageBox.top;
      if (top < SCOPE_LINE + 8 || top > stageBox.height - BAR_CLEARANCE)
        stage.scrollTop += top - stageBox.height / 2;
    }
  });

  // Dragging a long way draws other lines and drops the rows the drag began on. The
  // browser then moves that edge of the selection onto the list itself, so the last
  // line it was seen in is kept until the selection is cleared or starts elsewhere.
  const edges = useRef<{ anchor: Position | null; focus: Position | null }>({
    anchor: null,
    focus: null,
  });
  useEffect(() => {
    function track() {
      const list = listRef.current;
      const selection = window.getSelection();
      const { anchorNode, focusNode } = selection ?? {};
      if (
        !list ||
        !selection ||
        selection.isCollapsed ||
        !anchorNode ||
        !focusNode ||
        !list.contains(anchorNode) ||
        !list.contains(focusNode)
      ) {
        edges.current = { anchor: null, focus: null };
        return;
      }
      const anchor = positionOf(
        list,
        lines,
        anchorNode,
        selection.anchorOffset,
      );
      const focus = positionOf(list, lines, focusNode, selection.focusOffset);
      if (!anchor && !focus) return;
      edges.current = {
        anchor: anchor ?? edges.current.anchor,
        focus: focus ?? edges.current.focus,
      };
    }
    document.addEventListener("selectionchange", track);
    return () => document.removeEventListener("selectionchange", track);
  }, [lines]);

  function onCopy(event: ClipboardEvent) {
    const list = listRef.current;
    const selection = window.getSelection();
    if (
      !list ||
      !selection ||
      selection.isCollapsed ||
      !selection.anchorNode ||
      !selection.focusNode
    )
      return;
    // Select all: the list itself is both ends, and every line is meant, drawn or not.
    if (selection.anchorNode === list && selection.focusNode === list) {
      event.clipboardData.setData("text/plain", lines.join("\n"));
      event.preventDefault();
      return;
    }
    const anchor =
      positionOf(list, lines, selection.anchorNode, selection.anchorOffset) ??
      edges.current.anchor;
    const focus =
      positionOf(list, lines, selection.focusNode, selection.focusOffset) ??
      edges.current.focus;
    // Lines scrolled out of the drawn range still copy; the line numbers never do.
    if (!anchor || !focus) return;
    const forward =
      anchor.line < focus.line ||
      (anchor.line === focus.line && anchor.column <= focus.column);
    event.clipboardData.setData(
      "text/plain",
      forward
        ? selectionText(lines, anchor, focus)
        : selectionText(lines, focus, anchor),
    );
    event.preventDefault();
  }

  const currentBlock =
    active >= 0 ? Math.floor(matches[active]!.line / BLOCK_LINES) : -1;
  const drawn: ReactNode[] = [];
  for (let block = first; block <= Math.min(last, blocks - 1); block++)
    drawn.push(
      <Block
        key={block}
        block={block}
        lines={lines}
        offset={firstLine + dropped - 1}
        matches={matches}
        current={block === currentBlock ? active : -1}
      />,
    );
  const above = blocks ? tops[first]! : 0;
  const below = blocks
    ? tops[blocks]! - tops[Math.min(last, blocks - 1) + 1]!
    : 0;

  return (
    <>
      {note && (
        <p className="attachment-text-scope">
          <Info aria-hidden="true" />
          {note}
        </p>
      )}
      <div
        ref={listRef}
        role="document"
        aria-label={`Text of ${name}`}
        className="attachment-text"
        data-wrap={wrap ? "" : undefined}
        style={
          {
            "--text-hang": `${HANG}ch`,
            "--text-gutter": `${gutter}px`,
          } as CSSProperties
        }
        tabIndex={reachable ? 0 : undefined}
        onCopy={onCopy}
      >
        <span
          ref={probeRef}
          className="attachment-text-probe"
          aria-hidden="true"
        >
          {"0".repeat(PROBE_CHARS)}
        </span>
        <div style={{ height: above }} aria-hidden="true" />
        {drawn}
        <div style={{ height: below + BAR_CLEARANCE }} aria-hidden="true" />
      </div>
      <ViewBarFind
        finding={finding}
        wrap={wrap}
        query={query}
        onQuery={setQuery}
        count={matches.length}
        capped={found.capped}
        active={active}
        inputRef={inputRef}
        onOpen={openFind}
        onClose={closeFind}
        onStep={step}
        onWrap={toggleWrap}
      />
    </>
  );
}

/** The line above the text when it is not the whole file, in the fewest words. */
function scopeNote(scope: Scope, shown: number, dropped: number) {
  const rest = "Open it in its app for the rest.";
  if (dropped > 0)
    return `Showing the last ${shown.toLocaleString()} lines of ${formatSize(scope.total_bytes)}. ${rest}`;
  if (scope.partial)
    return `Showing the last ${formatSize(scope.shown_bytes)} of ${formatSize(scope.total_bytes)}. ${rest}`;
  return null;
}

function ViewBarFind({
  finding,
  wrap,
  query,
  onQuery,
  count,
  capped,
  active,
  inputRef,
  onOpen,
  onClose,
  onStep,
  onWrap,
}: {
  finding: boolean;
  wrap: boolean;
  query: string;
  onQuery: (value: string) => void;
  count: number;
  capped: boolean;
  active: number;
  inputRef: RefObject<HTMLInputElement | null>;
  onOpen: () => void;
  onClose: () => void;
  onStep: (direction: 1 | -1) => void;
  onWrap: () => void;
}) {
  const status = !query
    ? ""
    : count === 0
      ? "No matches"
      : `${(active + 1).toLocaleString()} of ${count.toLocaleString()}${capped ? "+" : ""}`;
  return (
    <ViewBar label="View">
      <ViewBarGroup label="Find">
        {finding ? (
          <>
            <span className="view-bar-search">
              <Search aria-hidden="true" />
              <Input
                ref={inputRef}
                variant="inline"
                className="h-6 w-44"
                aria-label="Find in the text"
                placeholder="Find"
                autoComplete="off"
                spellCheck={false}
                data-view-field=""
                value={query}
                onChange={(event) => onQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    onStep(event.shiftKey ? -1 : 1);
                  } else if (event.key === "Escape") onClose();
                }}
              />
            </span>
            <span
              className="view-bar-of attachment-text-count"
              role="status"
              aria-live="polite"
            >
              {status}
            </span>
            <IconButton
              label="Previous match"
              disabled={count === 0}
              onClick={() => onStep(-1)}
            >
              <ChevronUp aria-hidden="true" />
            </IconButton>
            <IconButton
              label="Next match"
              disabled={count === 0}
              onClick={() => onStep(1)}
            >
              <ChevronDown aria-hidden="true" />
            </IconButton>
            <IconButton label="Close find" onClick={onClose}>
              <X aria-hidden="true" />
            </IconButton>
          </>
        ) : (
          <Button
            variant="ghost"
            size="compact"
            aria-keyshortcuts="Meta+F /"
            onClick={onOpen}
          >
            <Search aria-hidden="true" />
            Find
          </Button>
        )}
      </ViewBarGroup>
      <ViewBarGroup>
        <Button
          variant="ghost"
          size="compact"
          aria-pressed={wrap}
          aria-keyshortcuts="W"
          onClick={onWrap}
        >
          <WrapText aria-hidden="true" />
          Wrap lines
        </Button>
      </ViewBarGroup>
    </ViewBar>
  );
}

/** A group of lines, drawn again only when its lines or its matches change. */
const Block = memo(function Block({
  block,
  lines,
  offset,
  matches,
  current,
}: {
  block: number;
  lines: readonly string[];
  /** The file's line number of the first line, less one. */
  offset: number;
  matches: readonly Match[];
  /** The index of the current match when it is in this block, else -1. */
  current: number;
}) {
  const from = block * BLOCK_LINES;
  const to = Math.min(from + BLOCK_LINES, lines.length);
  const rows: ReactNode[] = [];
  let next = matches.length ? firstMatchFrom(matches, from) : 0;
  for (let line = from; line < to; line++) {
    const start = next;
    while (next < matches.length && matches[next]!.line === line) next++;
    rows.push(
      <div
        key={line}
        className="attachment-text-line"
        data-line={line}
        data-n={offset + line + 1}
      >
        <span className="attachment-text-content">
          {start === next
            ? lines[line]
            : marked(lines[line]!, matches, start, next, current)}
        </span>
      </div>,
    );
  }
  return <div data-block={block}>{rows}</div>;
});

/** A line with its matches (`matches[start..end]`) set apart; the current one is marked. */
function marked(
  text: string,
  matches: readonly Match[],
  start: number,
  end: number,
  current: number,
) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (let index = start; index < end; index++) {
    const match = matches[index]!;
    if (match.start > at) parts.push(text.slice(at, match.start));
    parts.push(
      <mark
        key={index}
        className="attachment-text-match"
        data-current={index === current ? "" : undefined}
      >
        {text.slice(match.start, match.end)}
      </mark>,
    );
    at = match.end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

/** The line and character a selection edge sits at, or null when it is not in a line. */
function positionOf(
  list: HTMLElement,
  lines: readonly string[],
  node: Node,
  offset: number,
): Position | null {
  const element = node instanceof Element ? node : node.parentElement;
  const row = element?.closest<HTMLElement>("[data-line]");
  if (!row || !list.contains(row)) return null;
  const line = Number(row.dataset["line"]);
  const content = row.querySelector(".attachment-text-content");
  if (!content) return null;
  if (!content.contains(node))
    return { line, column: offset > 0 ? (lines[line]?.length ?? 0) : 0 };
  const range = document.createRange();
  range.setStart(content, 0);
  range.setEnd(node, offset);
  return { line, column: range.toString().length };
}
