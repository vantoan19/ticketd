import { createContext, useContext } from "react";
import type { Reads } from "./engine";

export const ReadsContext = createContext<Reads | null>(null);

/** The reads of the enclosing WorkspaceReads; `user` names the hook for the error. */
export function useReads(user: string): Reads {
  const reads = useContext(ReadsContext);
  if (!reads) throw new Error(`${user} must be used inside <WorkspaceReads>.`);
  return reads;
}
