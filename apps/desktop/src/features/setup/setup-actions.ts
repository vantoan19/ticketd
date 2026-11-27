import { createContext } from "react";

/**
 * What Set up ticketd can start outside Settings: the shell opens the ticket
 * dialog and the Chats screen. Null outside the app shell (a test, a preview),
 * where those buttons are left out.
 */
export interface SetupActions {
  /** Opens New ticket; focus returns to `trigger` when it closes. */
  newTicket: (trigger: HTMLButtonElement) => void;
  /** Opens a new Chat; null while Chats are off. */
  startChat: (() => void) | null;
  /** Why New ticket can't open now, if it can't. */
  newTicketDisabledReason: string | null;
}

export const SetupActionsContext = createContext<SetupActions | null>(null);
