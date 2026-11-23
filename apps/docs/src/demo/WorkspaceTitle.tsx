import { ChevronDown } from "lucide-react";
import { planName } from "./workspace";
import type { Pane } from "./state";

const names = {
  plan: planName,
  inbox: "Inbox",
  ready: "Ready",
  spec: "Documents",
} as const;

/** The narrow display uses its title as a native workspace selector. It keeps the
 * Plan, Inbox, Ready view and Document within reach without a permanent sidebar. */
export function WorkspaceTitle({
  pane,
  view,
}: {
  pane: Pane;
  view: (pane: Pane) => void;
}) {
  return (
    <>
      <strong className="workspace-heading">{names[pane]}</strong>
      <label className="workspace-picker">
        <select
          aria-label="Demonstration workspace view"
          data-demo-control="workspace-picker"
          value={pane}
          onChange={(event) => view(event.target.value as keyof typeof names)}
        >
          {Object.entries(names).map(([value, title]) => (
            <option key={value} value={value}>
              {title}
            </option>
          ))}
        </select>
        <ChevronDown size={12} aria-hidden="true" />
      </label>
    </>
  );
}
