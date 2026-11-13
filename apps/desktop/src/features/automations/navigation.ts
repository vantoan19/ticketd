import { createContext } from "react";

/** Opens a run in the Automations page, from a ticket or the Inbox. */
export const RunNavigation = createContext<((runId: string) => void) | null>(
  null,
);
