import { arriveWorkspace } from "./arrive";

/**
 * App launch (DESIGN.md section 12): the sidebar fades in, the content pane
 * fades up a step later, then the header and the visible rows inside it follow
 * in a cascade. Run it when the window opens and after a workspace switch,
 * never when returning to the window. Rows that arrive after the first paint
 * belong to their list, not to the launch.
 */
export function launch(workspace: HTMLElement): void {
  arriveWorkspace(
    workspace.querySelector(".sidebar"),
    workspace.querySelector<HTMLElement>(".content-panel"),
  );
}
