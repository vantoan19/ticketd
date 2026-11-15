import { useEffect, useRef, useState, type RefObject } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { failureText } from "@/lib/api/describe-failure";

/**
 * Tauri intercepts OS file drops before DOM DataTransfer can expose paths.
 * `onOver` hears whether files are being dragged over the target, for a
 * "Drop to upload" state.
 */
export function useNativeFileDrop(
  target: RefObject<HTMLElement | null>,
  enabled: boolean,
  onDrop: (paths: string[], point: { x: number; y: number }) => void,
  onOver?: (over: boolean) => void,
) {
  const receive = useRef(onDrop);
  const hover = useRef(onOver);
  const [failure, setFailure] = useState("");
  useEffect(() => {
    receive.current = onDrop;
    hover.current = onOver;
  }, [onDrop, onOver]);
  useEffect(() => {
    if (!enabled || !("__TAURI_INTERNALS__" in window)) return;
    let stopped = false;
    let unlisten: (() => void) | undefined;
    void Promise.resolve()
      .then(() =>
        getCurrentWebview()
          .onDragDropEvent(({ payload }) => {
            if (stopped) return;
            if (payload.type === "leave") {
              hover.current?.(false);
              return;
            }
            const bounds = target.current?.getBoundingClientRect();
            const x = payload.position.x / window.devicePixelRatio;
            const y = payload.position.y / window.devicePixelRatio;
            const hit = document.elementFromPoint?.(x, y);
            // Bounds alone also match editors underneath a modal or another pane.
            const inside =
              !(hit && !target.current?.contains(hit)) &&
              bounds !== undefined &&
              x >= bounds.left &&
              x <= bounds.right &&
              y >= bounds.top &&
              y <= bounds.bottom;
            if (payload.type !== "drop") {
              hover.current?.(inside);
              return;
            }
            hover.current?.(false);
            if (inside) receive.current(payload.paths, { x, y });
          })
          .then((stop) => {
            if (stopped) stop();
            else unlisten = stop;
          }),
      )
      .catch((reason: unknown) => {
        if (!stopped)
          setFailure(
            `${failureText(reason, "turn on file drop")} Use Choose files instead.`,
          );
      });
    return () => {
      stopped = true;
      unlisten?.();
    };
  }, [target, enabled]);
  return failure;
}
