import { createContext } from "react";

/** `backLabel` names where the reader's Back goes when the caller knows (a Plan). */
export const DocumentNavigation = createContext<
  ((id: string, backLabel?: string) => void) | null
>(null);

export const PlanNavigation = createContext<((id: string) => void) | null>(
  null,
);

/** Opens a Project's tickets, by its id. */
export const ProjectNavigation = createContext<((id: string) => void) | null>(
  null,
);

/**
 * Opens the graph around an item (a ticket reference, Document or Plan id);
 * `dependencies` opens a ticket's graph on its dependencies.
 */
export const ContextGraphNavigation = createContext<
  | ((
      id: string,
      options?: { dependencies?: boolean; workspacePlan?: string },
    ) => void)
  | null
>(null);
