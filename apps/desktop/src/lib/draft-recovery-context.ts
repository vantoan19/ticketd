import { createContext, useContext, type ReactNode } from "react";
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
  reloadAfterRestore: () => Promise<void>;
};

// Standalone views can still render outside the application recovery boundary.
export const DraftRecoveryContext = createContext<DraftRecovery>({
  active: false,
  retry: () => {},
  read: () => null,
  put: async () => {},
  flush: async () => {},
  reloadAfterRestore: async () => {},
});
export const DraftRecoveryGenerationContext = createContext(0);
export const DraftRecoveryErrorContext = createContext("");
export const useDraftRecovery = () => useContext(DraftRecoveryContext);
export const useDraftRecoveryGeneration = () =>
  useContext(DraftRecoveryGenerationContext);
export const useDraftRecoveryError = () =>
  useContext(DraftRecoveryErrorContext);
/** The window-level recovery notices, for the shell to place in the page flow. */
export const DraftRecoveryNoticesContext = createContext<ReactNode>(null);
export const useDraftRecoveryNotices = () =>
  useContext(DraftRecoveryNoticesContext);
