import { homeRelative, splitPathMiddle } from "@/features/projects/paths";
import "./projects.css";

/** A path on one line: "/private/…/8b654d0c/repo-api", with the full path on hover. */
export function PathText({ path }: { path: string }) {
  const { lead, middle, tail } = splitPathMiddle(homeRelative(path));
  return (
    <span className="path-text" title={path}>
      {lead && <span className="path-lead">{lead}</span>}
      {middle && (
        // Right-to-left puts the ellipsis at the start of the shrinking part;
        // the inner span keeps the characters in reading order.
        <span className="path-middle">
          <bdo dir="ltr">{middle}</bdo>
        </span>
      )}
      <span className="path-tail">{tail}</span>
    </span>
  );
}
