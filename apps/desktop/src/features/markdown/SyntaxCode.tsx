import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { RootContent } from "hast";

type Lowlight = (typeof import("./syntax-highlighting"))["codeLowlight"];

/** Set once the highlighter has loaded, with the first code block read. */
let loaded: Lowlight | undefined;

export function SyntaxCode({
  source,
  language,
}: {
  source: string;
  language: string;
}) {
  const [lowlight, setLowlight] = useState(loaded);
  useEffect(() => {
    if (lowlight) return;
    let live = true;
    void import("./syntax-highlighting").then(({ codeLowlight }) => {
      loaded = codeLowlight;
      if (live) setLowlight(() => codeLowlight);
    });
    return () => {
      live = false;
    };
  }, [lowlight]);
  const tokens = useMemo(() => {
    const tree = lowlight?.highlight(language, source);
    return tree?.children.length ? toReact(tree.children) : null;
  }, [lowlight, source, language]);
  return <code>{tokens ?? source}</code>;
}

/** The highlighter's tree is text in classed spans, rendered as React owns it. */
function toReact(nodes: RootContent[]): ReactNode[] {
  return nodes.map((node, index) =>
    node.type === "text" ? (
      node.value
    ) : node.type === "element" ? (
      <span
        key={index}
        className={[node.properties.className ?? []].flat().join(" ")}
      >
        {toReact(node.children)}
      </span>
    ) : null,
  );
}
