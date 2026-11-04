import { createContext } from "react";

export const DocumentNavigation = createContext<((id: string) => void) | null>(
  null,
);

export const PlanNavigation = createContext<((id: string) => void) | null>(
  null,
);

export const ContextGraphNavigation = createContext<
  ((id: string) => void) | null
>(null);
