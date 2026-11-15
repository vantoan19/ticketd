import {
  createContext,
  createElement,
  useContext,
  type ReactNode,
} from "react";

const Boundary = createContext<HTMLElement | null>(null);

/**
 * The region that menus, selects and popovers opened inside it must stay
 * within (DESIGN.md section 11, P3): the content panel for the app, a pane
 * body for pickers inside a pane. They flip and shift against it with 16px
 * clearance, so an overlay never escapes over the sidebar or covers its own
 * pane's header. Dialogs reset it, since they float over every pane.
 */
export function OverlayBoundary({
  element,
  children,
}: {
  element: HTMLElement | null;
  children: ReactNode;
}) {
  return createElement(Boundary, { value: element }, children);
}

/**
 * The collision boundary for an overlay content component: the nearest
 * OverlayBoundary, or the viewport (Radix's default) when there is none.
 */
export function useOverlayBoundary(): HTMLElement[] {
  const element = useContext(Boundary);
  return element ? [element] : [];
}
