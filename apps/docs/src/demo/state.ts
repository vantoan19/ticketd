import { entriesAt, type EntryId } from "./inbox-model";
import { nextStage, stages, type Stage, type Status } from "./workspace";

export type Pane = "plan" | "inbox" | "ready" | "spec";
type PlanView = "flow" | "board";
export interface DemoState {
  stage: Stage;
  pane: Pane;
  planView: PlanView;
  boardColumn: Status;
  ticket: string | null;
  playing: boolean;
  readEntries: readonly EntryId[];
}
export type DemoAction =
  | { type: "step"; stage: Stage }
  | { type: "tick" | "pause" | "toggle" | "back" }
  | { type: "pane"; pane: Pane }
  | { type: "plan-view"; view: PlanView }
  | { type: "column"; status: Status }
  | { type: "ticket"; reference: string }
  | { type: "read"; ids: readonly EntryId[] };
function guidedView(stage: Stage) {
  return {
    pane: stage === 2 ? "inbox" : "plan",
    planView: stage === 0 ? "flow" : "board",
    boardColumn: stages[stage].status,
  } as const;
}
export const initialDemo: DemoState = {
  stage: 0,
  ...guidedView(0),
  ticket: null,
  playing: true,
  readEntries: [],
};
export function demoReducer(state: DemoState, action: DemoAction): DemoState {
  switch (action.type) {
    case "tick":
    case "step": {
      if (action.type === "tick" && !state.playing) return state;
      const stage =
        action.type === "step" ? action.stage : nextStage(state.stage);
      const available = entriesAt(stage);
      return {
        stage,
        ...guidedView(stage),
        ticket: null,
        playing: action.type === "tick",
        readEntries: state.readEntries.filter((id) =>
          available.some((entry) => id === entry.id),
        ),
      };
    }
    case "read":
      return {
        ...state,
        playing: false,
        readEntries: [...new Set([...state.readEntries, ...action.ids])],
      };
    case "pause":
      return state.playing ? { ...state, playing: false } : state;
    case "toggle":
      return state.playing
        ? { ...state, playing: false }
        : { ...state, ...guidedView(state.stage), ticket: null, playing: true };
    case "ticket":
      return { ...state, ticket: action.reference, playing: false };
    case "back":
      return { ...state, ticket: null, playing: false };
    case "pane":
      return { ...state, pane: action.pane, ticket: null, playing: false };
    case "plan-view":
      return { ...state, planView: action.view, playing: false };
    case "column":
      return { ...state, boardColumn: action.status, playing: false };
  }
}
