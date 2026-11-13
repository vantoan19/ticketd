/** The id of the trigger's card; the core names trigger problems the same way. */
export const TRIGGER_ID = "trigger";

export const CARD_WIDTH = 240;
export const CARD_HEIGHT = 76;
/** The line between two cards, which is also where a step is inserted. */
export const GAP = 56;
/** The + that ends a path. */
export const END_SIZE = 32;

export type FlowItem =
  /** The trigger or a step. */
  | { kind: "card"; id: string; x: number; y: number }
  /**
   * Where a step can be added, at `index` of the steps and after the card
   * `after`: `add` is the line between two cards (CARD_WIDTH by GAP), `end` the
   * + that ends the path (END_SIZE square).
   */
  | {
      kind: "add" | "end";
      id: string;
      index: number;
      after: string;
      x: number;
      y: number;
    };

export type FlowLayout = {
  /** Top-left positions, in the order the steps run, which is the Tab order. */
  items: FlowItem[];
  edges: { id: string; source: string; target: string }[];
};

/**
 * Arranges a flow top to bottom: the trigger, then each step directly below the
 * one before, with a place to add a step on every line and at the end.
 */
// ponytail: lays out the top-level steps only. If paths (side by side) and
// failure paths (to the side) need subtree widths; add them with those steps.
export function layoutFlow(stepIds: string[]): FlowLayout {
  const pitch = CARD_HEIGHT + GAP;
  const cards = [TRIGGER_ID, ...stepIds];
  const items: FlowItem[] = [];
  const edges: FlowLayout["edges"] = [];
  cards.forEach((id, row) => {
    const previous = cards[row - 1];
    if (previous !== undefined) {
      items.push({
        kind: "add",
        id: `add-${row - 1}`,
        index: row - 1,
        after: previous,
        x: 0,
        y: row * pitch - GAP,
      });
      edges.push({ id: `${previous}>${id}`, source: previous, target: id });
    }
    items.push({ kind: "card", id, x: 0, y: row * pitch });
  });
  const last = cards.at(-1) ?? TRIGGER_ID;
  const end = `add-${stepIds.length}`;
  items.push({
    kind: "end",
    id: end,
    index: stepIds.length,
    after: last,
    x: (CARD_WIDTH - END_SIZE) / 2,
    y: cards.length * pitch,
  });
  edges.push({ id: `${last}>${end}`, source: last, target: end });
  return { items, edges };
}
