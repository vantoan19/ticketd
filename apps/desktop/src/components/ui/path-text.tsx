import { homeRelative, splitPathMiddle, withoutVerbatim } from "@/lib/paths";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import "./patterns.css";

/** One line that shortens in its middle: "/private/…/8b654d0c/repo-api". */
function MiddleTruncated({ path }: { path: string }) {
  const { lead, middle, tail } = splitPathMiddle(path);
  return (
    <>
      {lead && <span className="ui-path-lead">{lead}</span>}
      {middle && (
        // Right-to-left puts the ellipsis at the start of the shrinking part;
        // the inner element keeps the characters in reading order.
        <span className="ui-path-middle">
          <bdo dir="ltr">{middle}</bdo>
        </span>
      )}
      <span className="ui-path-tail">{tail}</span>
    </>
  );
}

/**
 * A file or folder path that never breaks mid-word. `stacked` (the default)
 * puts the name on line 1 (13px mono 500) and its folder on line 2 (12px
 * muted, shortened in the middle); `inline` is one line for a sentence;
 * `folder` is one muted caption line. The full path shows in a tooltip; put
 * Copy path (CopyButton) and "Show in Finder" beside it, never the path as a
 * label.
 */
export function PathText({
  path,
  layout = "stacked",
}: {
  path: string;
  layout?: "stacked" | "inline" | "folder";
}) {
  const shown = homeRelative(path);
  const full = withoutVerbatim(path);
  let content;
  if (layout === "stacked") {
    const separator = shown.includes("\\") && !shown.includes("/") ? "\\" : "/";
    const trimmed = shown.replace(/[\\/]+$/, "");
    const at = trimmed.lastIndexOf(separator);
    const name = at >= 0 ? trimmed.slice(at + 1) : trimmed;
    const folder = at > 0 ? trimmed.slice(0, at) : "";
    content = (
      <span
        data-slot="path-text"
        data-layout="stacked"
        className="ui-path-text"
      >
        <span className="ui-path-name">{name}</span>
        {folder && (
          <span className="ui-path-folder">
            <MiddleTruncated path={folder} />
          </span>
        )}
      </span>
    );
  } else {
    content = (
      <span data-slot="path-text" data-layout={layout} className="ui-path-text">
        <MiddleTruncated path={shown} />
      </span>
    );
  }
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent>{full}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
