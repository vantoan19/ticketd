/** The id of the trigger's card; the core names trigger problems the same way. */
export const TRIGGER_ID = "trigger";

export const CARD_WIDTH = 240;
export const CARD_HEIGHT = 76;
/** The line between two cards, which is also where a step is inserted. */
export const GAP = 56;
/** The + that ends a path. */
export const END_SIZE = 32;
/** Between two paths side by side. */
const PATH_GAP = 48;
/** Added below an If, so its lines have room to part and say Yes and No. */
const BRANCH_DROP = 20;

/** A step as the layout sees it: its id and the lists of steps under it. */
export type FlowStep = {
  id: string;
  /** An If's two paths. */
  yes?: FlowStep[];
  no?: FlowStep[];
  /** The path taken when the step fails; null or absent when it has none. */
  on_failure?: FlowStep[] | null;
};

/** How a line leaves its step when it is not simply the next step. */
export type FlowPath = "yes" | "no" | "failure";
/** A list of steps under a step. The flow's own list has no owner. */
export type FlowList = { step: string; path: FlowPath };

export type FlowItem =
  /** The trigger or a step. */
  | { kind: "card"; id: string; x: number; y: number }
  /**
   * Where a step can be added, at `index` of the steps of `list` (the flow's
   * own steps when absent) and after the card `after`: `add` is the line above
   * a card (CARD_WIDTH by GAP), `end` the + that ends the path (END_SIZE
   * square).
   */
  | {
      kind: "add" | "end";
      id: string;
      index: number;
      after: string;
      list?: FlowList;
      x: number;
      y: number;
    };

export type FlowEdge = {
  id: string;
  source: string;
  target: string;
  path?: FlowPath;
};

export type FlowLayout = {
  /**
   * Top-left positions, in the order the steps run, which is the Tab order: a
   * failure path after its step, Yes before No.
   */
  items: FlowItem[];
  edges: FlowEdge[];
};

/** Part of a flow, placed from its own left edge. */
type Block = {
  items: FlowItem[];
  edges: FlowEdge[];
  width: number;
  /** The x its first card is centered on. */
  axis: number;
  /** The id of its first item, where the line from above arrives. */
  first: string;
};

const edge = (source: string, target: string, path?: FlowPath): FlowEdge => ({
  id: `${source}>${target}`,
  source,
  target,
  ...(path && { path }),
});

const moved = (block: Block, dx: number): Block => ({
  ...block,
  items: block.items.map((item) => ({ ...item, x: item.x + dx })),
  axis: block.axis + dx,
});

/**
 * Places `steps` from `index` on, the first with its top at `y`, below the
 * card `after`. Paths never rejoin, so nothing is ever placed under a path:
 * a block only has to know how wide it is.
 */
function column(
  steps: FlowStep[],
  index: number,
  after: string,
  y: number,
  height: number,
  list?: FlowList,
): Block {
  const id = `add-${list ? `${list.step}.${list.path}-` : ""}${index}`;
  const place = { id, index, after, ...(list && { list }) };
  const step = steps[index];
  if (!step)
    return {
      items: [{ kind: "end", ...place, x: (CARD_WIDTH - END_SIZE) / 2, y }],
      edges: [],
      width: CARD_WIDTH,
      axis: CARD_WIDTH / 2,
      first: id,
    };
  const below = y + height + GAP;
  const path = (path: FlowPath, steps: FlowStep[], y: number) =>
    column(steps, 0, step.id, y, height, { step: step.id, path });
  let under: Block;
  if (step.yes || step.no) {
    // An If ends its list: the run goes down one of its paths and ends there,
    // so steps written after it never run and are not drawn.
    const yes = path("yes", step.yes ?? [], below + BRANCH_DROP);
    const no = moved(
      path("no", step.no ?? [], below + BRANCH_DROP),
      yes.width + PATH_GAP,
    );
    under = {
      items: [...yes.items, ...no.items],
      edges: [
        edge(step.id, yes.first, "yes"),
        edge(step.id, no.first, "no"),
        ...yes.edges,
        ...no.edges,
      ],
      width: yes.width + PATH_GAP + no.width,
      axis: (yes.axis + no.axis) / 2,
      first: "",
    };
  } else {
    const next = column(steps, index + 1, step.id, below, height, list);
    under = { ...next, edges: [edge(step.id, next.first), ...next.edges] };
  }
  // A failure path starts one row down, to the side of all that is under its
  // step, so its line leaves the step's side and crosses nothing.
  const failure =
    step.on_failure &&
    moved(path("failure", step.on_failure, below), under.width + PATH_GAP);
  const x = under.axis - CARD_WIDTH / 2;
  return {
    items: [
      { kind: "add", ...place, x, y: y - GAP },
      { kind: "card", id: step.id, x, y },
      ...(failure?.items ?? []),
      ...under.items,
    ],
    edges: [
      ...(failure
        ? [edge(step.id, failure.first, "failure"), ...failure.edges]
        : []),
      ...under.edges,
    ],
    width: failure ? under.width + PATH_GAP + failure.width : under.width,
    axis: under.axis,
    first: step.id,
  };
}

/**
 * Arranges a flow top to bottom: the trigger, then each step directly below the
 * one before, with a place to add a step on every line and at the end of every
 * path. An If's Yes and No paths sit side by side below it; a failure path sits
 * to the side of its step. `cardHeight` is the height every card is drawn at.
 */
export function layoutFlow(
  steps: FlowStep[],
  cardHeight = CARD_HEIGHT,
): FlowLayout {
  const flow = column(steps, 0, TRIGGER_ID, cardHeight + GAP, cardHeight);
  return {
    items: [
      { kind: "card", id: TRIGGER_ID, x: flow.axis - CARD_WIDTH / 2, y: 0 },
      ...flow.items,
    ],
    edges: [edge(TRIGGER_ID, flow.first), ...flow.edges],
  };
}

/* Where the view of a flow goes. */

type Box = { x: number; y: number; width: number; height: number };
/** The smallest a flow is drawn without being asked: its cards still read. */
export const READABLE_ZOOM = 0.75;
/** The least kept clear around a flow at its smallest readable size. */
export const VIEW_MARGIN = 16;
/** Above the first card when the flow is too tall to show whole. */
const TOP = 32;
/** Kept clear at the bottom for the zoom control: its height and its offset. */
export const ZOOM_ROOM = 48;

/**
 * The smallest a canvas goes, by the zoom control or Fit: small enough that
 * Fit shows a wide flow whole in the narrowest canvas beside the panel.
 */
export const LEAST_ZOOM = 0.1;
/** The least a selected card is shrunk to so its failure path shows beside it (#387 D13). */
export const LEAST_FOCUS_ZOOM = 0.5;

/**
 * The size that shows all of `focus` (a selected card with the first step of
 * its failure path): the readable size when it fits there, else smaller, but
 * never below LEAST_FOCUS_ZOOM.
 */
export function focusZoom(
  focus: Box,
  canvas: { width: number; height: number },
) {
  const fits = Math.min(
    (canvas.width - 2 * VIEW_MARGIN) / focus.width,
    (canvas.height - TOP - ZOOM_ROOM) / focus.height,
  );
  return Math.min(READABLE_ZOOM, Math.max(LEAST_FOCUS_ZOOM, fits));
}

/** Where cards may be cut: at or past half a pixel over a line. */
const CUT = 0.5;

/** Whether a card (`spans` on one axis) is cut in half at 0 or `edge`. */
function cutAt(
  offset: number,
  zoom: number,
  edge: number,
  spans: [number, number][],
) {
  return spans.some(([from, to]) =>
    [0, edge].some(
      (line) =>
        offset + from * zoom < line - CUT && offset + to * zoom > line + CUT,
    ),
  );
}

/**
 * `offset` on one axis, moved as little as it takes so no card (`spans`, from
 * and to on that axis) is cut in half at either edge of the canvas (0 and
 * `edge`) while `keep` stays whole; showing all of `focus` too comes first.
 * Unchanged when nothing is cut, or when no such place exists.
 */
function uncut(
  offset: number,
  zoom: number,
  edge: number,
  lead: number,
  tail: number,
  spans: [number, number][],
  keep: [number, number],
  focus: [number, number],
) {
  const at = (o: number, value: number) => o + value * zoom;
  const cuts = (o: number) => cutAt(o, zoom, edge, spans);
  const whole = (o: number, [from, to]: [number, number]) =>
    at(o, from) >= -CUT && at(o, to) <= edge + CUT;
  if (!cuts(offset)) return offset;
  // Every place where some card meets a margin or an edge exactly: the ends
  // of each stretch where nothing is cut, and the margins inside them.
  const fine = spans
    .flatMap(([from, to]) => [
      lead - from * zoom,
      tail - to * zoom,
      -from * zoom,
      -to * zoom,
      edge - from * zoom,
      edge - to * zoom,
    ])
    .filter((o) => !cuts(o) && whole(o, keep));
  const cost = (o: number) =>
    (whole(o, focus) ? 0 : edge * 100) + Math.abs(o - offset);
  return fine.reduce<number>(
    (best, o) => (cost(o) < cost(best) ? o : best),
    fine[0] ?? offset,
  );
}

/**
 * Where a flow too big to show whole goes at `zoom`, the readable size unless
 * said otherwise, one axis at a
 * time. An axis the flow fits is centered on the whole flow. On one it does
 * not, `focus` is shown, centered, or with its top at the top when `fromTop`,
 * but the view never runs past either end of the flow. Given the `cards`, it
 * then moves the least it takes to cut none in half at an edge, keeping
 * `keep` (the selected card) whole.
 */
export function readableViewport(
  flow: Box,
  focus: Box,
  canvas: { width: number; height: number },
  fromTop: boolean,
  zoom = READABLE_ZOOM,
  cards: Box[] = [],
  keep: Box = focus,
) {
  const place = (
    start: number,
    length: number,
    focusStart: number,
    focusLength: number,
    room: number,
    lead: number,
    alignStart: boolean,
    edge: number,
    spans: [number, number][],
    kept: [number, number],
  ) => {
    // Whole, even if that leaves less than the margin at its sides.
    if (length * zoom <= room) return room / 2 - (start + length / 2) * zoom;
    // A focus wider than the room shows its start whole: the selected card.
    const wanted =
      alignStart || focusLength * zoom > room - 2 * VIEW_MARGIN
        ? lead - focusStart * zoom
        : room / 2 - (focusStart + focusLength / 2) * zoom;
    const first = lead - start * zoom;
    const last = room - VIEW_MARGIN - (start + length) * zoom;
    return uncut(
      Math.min(first, Math.max(last, wanted)),
      zoom,
      edge,
      lead,
      room - VIEW_MARGIN,
      spans,
      kept,
      [focusStart, focusStart + focusLength],
    );
  };
  return {
    x: place(
      flow.x,
      flow.width,
      focus.x,
      focus.width,
      canvas.width,
      VIEW_MARGIN,
      false,
      canvas.width,
      cards.map((card) => [card.x, card.x + card.width]),
      [keep.x, keep.x + keep.width],
    ),
    y: place(
      flow.y,
      flow.height,
      focus.y,
      focus.height,
      canvas.height - ZOOM_ROOM,
      TOP,
      fromTop,
      canvas.height,
      cards.map((card) => [card.y, card.y + card.height]),
      [keep.y, keep.y + keep.height],
    ),
    zoom,
  };
}

/** How much smaller each try of the automatic view is than the last. */
const ZOOM_STEP = 0.01;

/**
 * The view a flow too big to show whole opens at: `readableViewport` at
 * `zoom`, or a little smaller where only that cuts no card in half at an edge
 * of the canvas. Small enough, the whole flow shows, which cuts none.
 */
export function automaticViewport(
  flow: Box,
  focus: Box,
  canvas: { width: number; height: number },
  fromTop: boolean,
  zoom: number,
  cards: Box[],
  keep: Box,
) {
  const xs = cards.map((card): [number, number] => [
    card.x,
    card.x + card.width,
  ]);
  const ys = cards.map((card): [number, number] => [
    card.y,
    card.y + card.height,
  ]);
  for (let at = zoom; ; at -= ZOOM_STEP) {
    const view = readableViewport(
      flow,
      focus,
      canvas,
      fromTop,
      at,
      cards,
      keep,
    );
    const clean =
      !cutAt(view.x, at, canvas.width, xs) &&
      !cutAt(view.y, at, canvas.height, ys);
    if (clean || at - ZOOM_STEP < LEAST_ZOOM) return view;
  }
}
