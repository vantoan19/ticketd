import { createContext } from "react";

/**
 * Names the group of rows whose highlight travels together: one id per open
 * menu, select or list, so two open at once never trade highlights.
 */
export const HighlightGroup = createContext<string | null>(null);
