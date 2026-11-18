import type { CSSProperties } from "react";
import "./enter.css";

/**
 * Props that make an element one step of its page's own entrance. Spread them on
 * the element: `<li {...enter(index)}>`. Step 0 is the header, later steps follow
 * a stagger apart (eight at most). The page root needs `data-own-entrance`; see
 * enter.css.
 */
export function enter(step = 0) {
  return {
    "data-enter": "",
    style: { "--enter-step": step } as CSSProperties,
  };
}
