import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

const DRAG_THRESHOLD = 4;

export function hasPanOverflow(stage: HTMLElement) {
  return (
    stage.scrollWidth > stage.clientWidth ||
    stage.scrollHeight > stage.clientHeight
  );
}

export function useDragPan(scrollerRef: RefObject<HTMLElement | null>) {
  const [dragging, setDragging] = useState(false);
  const dragListeners = useRef<AbortController | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => () => dragListeners.current?.abort(), []);

  function startPan(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    suppressClick.current = false;
    const stage = scrollerRef.current;
    // Touch already pans the scroll container with the platform's gestures.
    if (event.pointerType !== "mouse" || !stage || !hasPanOverflow(stage))
      return;
    const { pointerId, currentTarget } = event;
    currentTarget.setPointerCapture(pointerId);
    dragListeners.current?.abort();
    const controller = new AbortController();
    dragListeners.current = controller;
    const options = { signal: controller.signal };
    let x = event.clientX;
    let y = event.clientY;

    function endPan() {
      controller.abort();
      dragListeners.current = null;
      setDragging(false);
    }
    function endPointer(pointer: PointerEvent) {
      if (pointer.pointerId === pointerId) endPan();
    }
    // Listen through the end of the gesture even if the pointer crosses the
    // toolbar or the edge of the preview.
    window.addEventListener(
      "pointermove",
      (pointer) => {
        if (pointer.pointerId !== pointerId) return;
        const dx = pointer.clientX - x;
        const dy = pointer.clientY - y;
        if (!suppressClick.current) {
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
          suppressClick.current = true;
          setDragging(true);
        }
        stage.scrollLeft -= dx;
        stage.scrollTop -= dy;
        x = pointer.clientX;
        y = pointer.clientY;
      },
      options,
    );
    window.addEventListener("pointerup", endPointer, options);
    window.addEventListener("pointercancel", endPointer, options);
    window.addEventListener("lostpointercapture", endPointer, options);
    window.addEventListener("blur", endPan, options);
  }

  function consumeDragClick() {
    const suppressed = suppressClick.current;
    suppressClick.current = false;
    return suppressed;
  }

  return { dragging, startPan, consumeDragClick };
}
