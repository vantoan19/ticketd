import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Ticket } from "@/lib/api/client";
import { ticketStatusChoices } from "./ticket-source";
import type { TicketWorkspace } from "./useTicketWorkspace";

type Gesture = {
  ticket: Ticket;
  element: HTMLButtonElement;
  pointer: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  width: number;
  offsetX: number;
  offsetY: number;
  dragging: boolean;
};
type Drag = Gesture & { target: string | null };

/** Pointer geometry stays in the desktop; every drop uses the shared status action. */
export function useBoardDrag(workspace: TicketWorkspace) {
  const board = useRef<HTMLDivElement>(null);
  const latest = useRef(workspace);
  useEffect(() => {
    latest.current = workspace;
  });
  const gesture = useRef<Gesture | null>(null);
  const suppressedClick = useRef<HTMLButtonElement | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);

  useEffect(() => {
    let frame = 0;
    function currentTicket(active: Gesture) {
      return latest.current.board.columns
        .flatMap((column) => column.tickets)
        .find((ticket) => ticket.reference === active.ticket.reference);
    }
    function columnAt(active: Gesture) {
      const container = board.current;
      const bounds = container?.getBoundingClientRect();
      if (
        !container ||
        !bounds ||
        active.x < bounds.left ||
        active.x >= bounds.right ||
        active.y < bounds.top ||
        active.y >= bounds.bottom
      )
        return null;
      return (
        Array.from(
          container.querySelectorAll<HTMLElement>("[data-board-status]"),
        ).find((element) => {
          const rect = element.getBoundingClientRect();
          return active.x >= rect.left && active.x < rect.right;
        }) ?? null
      );
    }
    function destination(active: Gesture) {
      const column = columnAt(active);
      const status = column?.dataset.boardStatus;
      const ticket = currentTicket(active);
      if (
        !ticket ||
        ticket.trashed ||
        latest.current.statusAction.pending.has(ticket.reference) ||
        latest.current.statusAction.review?.ticket.reference ===
          ticket.reference ||
        status === ticket.status ||
        !status ||
        !ticketStatusChoices(ticket).includes(status)
      )
        return null;
      return status;
    }
    function show(active: Gesture) {
      setDrag({
        ...active,
        ticket: currentTicket(active) ?? active.ticket,
        target: destination(active),
      });
    }
    function edgeSpeed(position: number, start: number, end: number) {
      const edge = Math.min(40, (end - start) / 3);
      if (position < start + edge) return -18 * (1 - (position - start) / edge);
      if (position > end - edge) return 18 * (1 - (end - position) / edge);
      return 0;
    }
    function scroll() {
      frame = 0;
      const active = gesture.current;
      const container = board.current;
      if (!active?.dragging || !container) return;
      const bounds = container.getBoundingClientRect();
      const column = columnAt(active);
      if (column) {
        container.scrollLeft = Math.max(
          0,
          Math.min(
            container.scrollWidth - container.clientWidth,
            container.scrollLeft +
              edgeSpeed(active.x, bounds.left, bounds.right),
          ),
        );
        const body = column.querySelector<HTMLElement>(".board-column-body");
        if (body) {
          const rect = body.getBoundingClientRect();
          body.scrollTop = Math.max(
            0,
            Math.min(
              body.scrollHeight - body.clientHeight,
              body.scrollTop + edgeSpeed(active.y, rect.top, rect.bottom),
            ),
          );
        }
      }
      show(active);
      frame = requestAnimationFrame(scroll);
    }
    function stopScrolling() {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    function move(event: PointerEvent) {
      const active = gesture.current;
      if (!active || event.pointerId !== active.pointer) return;
      active.x = event.clientX;
      active.y = event.clientY;
      if (
        !active.dragging &&
        Math.hypot(active.x - active.startX, active.y - active.startY) < 6
      )
        return;
      active.dragging = true;
      suppressedClick.current = active.element;
      event.preventDefault();
      show(active);
      if (!frame) frame = requestAnimationFrame(scroll);
    }
    function finish(event: PointerEvent) {
      const active = gesture.current;
      if (!active || event.pointerId !== active.pointer) return;
      gesture.current = null;
      stopScrolling();
      setDrag(null);
      if (!active.dragging) return;
      active.x = event.clientX;
      active.y = event.clientY;
      const status = destination(active);
      const ticket = currentTicket(active);
      active.element.focus({ preventScroll: true });
      if (status && ticket)
        void latest.current.statusAction.choose(ticket, status);
    }
    function cancel() {
      const active = gesture.current;
      gesture.current = null;
      stopScrolling();
      setDrag(null);
      if (active?.dragging) active.element.focus({ preventScroll: true });
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape" && gesture.current) {
        event.preventDefault();
        cancel();
      }
    }
    function pointerCancel(event: PointerEvent) {
      if (event.pointerId === gesture.current?.pointer) cancel();
    }
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", pointerCancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", escape);
    return () => {
      stopScrolling();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", pointerCancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", escape);
    };
  }, []);

  return {
    board,
    drag,
    start(event: ReactPointerEvent<HTMLButtonElement>, ticket: Ticket) {
      suppressedClick.current = null;
      if (
        event.button !== 0 ||
        event.pointerType === "touch" ||
        ticket.trashed ||
        workspace.statusAction.pending.has(ticket.reference) ||
        workspace.statusAction.review?.ticket.reference === ticket.reference
      )
        return;
      const rect = event.currentTarget.getBoundingClientRect();
      gesture.current = {
        ticket,
        element: event.currentTarget,
        pointer: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        x: event.clientX,
        y: event.clientY,
        width: rect.width,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        dragging: false,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    open(element: HTMLButtonElement, detail: number) {
      if (detail > 0 && suppressedClick.current === element) {
        suppressedClick.current = null;
        return false;
      }
      return true;
    },
  };
}
