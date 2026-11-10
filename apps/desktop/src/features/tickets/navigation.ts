import { createContext } from "react";

export const TicketNavigation = createContext<
  ((reference: string) => void) | null
>(null);
