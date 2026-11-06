import { createContext, useContext } from "react";
import type { z } from "zod";

export type DraftRecovery = {
  active: boolean;
  retry: () => void;
  read: <T>(owner: string, schema: z.ZodType<T>) => T | null;
  put: (
    owner: string,
    payload: unknown,
    markdown: string[],
    kind?: "draft" | "undo",
  ) => Promise<void>;
  flush: () => Promise<void>;
};

// Standalone views can still render outside the application recovery boundary.
export const DraftRecoveryContext = createContext<DraftRecovery>({
  active: false,
  retry: () => {},
  read: () => null,
  put: async () => {},
  flush: async () => {},
});
export const DraftRecoveryErrorContext = createContext("");
export const useDraftRecovery = () => useContext(DraftRecoveryContext);
export const useDraftRecoveryError = () =>
  useContext(DraftRecoveryErrorContext);
