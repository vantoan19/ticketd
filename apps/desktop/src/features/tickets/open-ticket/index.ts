// The interface of the Open Ticket module (ADR 0013, GLOSSARY "Open Ticket").
// Test helpers are in "./testing" and are imported by tests only.
export { OpenTicket } from "./OpenTicket";
export { useOpenTicket } from "./open-ticket-context";
export type { OpenTicketState } from "./open-ticket-context";
export { useTicket } from "./use-ticket";
export type { TicketState } from "./use-ticket";
export type { Part } from "./parts";
export { TicketListSync, useTicketChanged } from "./changed";
export type { ReturnedTickets } from "./changed";

// The parts sections read through `useOpenTicket(part)`; one line per part.
import "./parts/linked-work";
import "./parts/evidence";
