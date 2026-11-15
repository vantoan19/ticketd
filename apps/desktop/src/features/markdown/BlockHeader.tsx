import type { ReactNode } from "react";

/**
 * The one header of a code or Mermaid block, the same while reading and
 * editing: a 32px band with the block's label ("ts", "Mermaid") at the left
 * and its actions (Source, Copy, Expand, or the language field) as icon
 * buttons at the right. It never appears or grows with focus.
 */
export function BlockHeader({
  label,
  children,
}: {
  label: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="markdown-block-toolbar" contentEditable={false}>
      <span className="markdown-block-label">{label}</span>
      {children && <span className="markdown-block-actions">{children}</span>}
    </div>
  );
}
