import { createContext } from "react";

/**
 * Where rail sections render: in the rail (a 12px label over its rows) or in
 * the reading column of a narrow pane, where they read as ordinary sections
 * with a SectionHeader (DESIGN.md section 7).
 */
export const RailPlacement = createContext<"rail" | "column">("rail");
