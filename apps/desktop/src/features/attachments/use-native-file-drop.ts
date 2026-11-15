import { useEffect, useRef, useState, type RefObject } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { failureText } from "@/lib/api/describe-failure";

/** Tauri intercepts OS file drops before DOM DataTransfer can expose paths. */
export function useNativeFileDrop(
  target: RefObject<HTMLElement | null>,
  enabled: boolean,
  onDrop: (paths: string[], point: { x: number; y: number }) => void,
) {
  const receive = useRef(onDrop);
  const [failure, setFailure] = useState("");
  useEffect(() => {
    receive.current = onDrop;
  }, [onDrop]);
  useEffect(() => {
    if (!enabled || !("__TAURI_INTERNALS__" in window)) return;
    let stopped = false;
    let unlisten: (() => void) | undefined;
    void Promise.resolve()
      .then(() =>
        getCurrentWebview()
          .onDragDropEvent(({ payload }) => {
            if (stopped || payload.type !== "drop") return;
            const bounds = target.current?.getBoundingClientRect();
            const x = payload.position.x / window.devicePixelRatio;
            const y = payload.position.y / window.devicePixelRatio;
            const hit = document.elementFromPoint?.(x, y);
            // Bounds alone also match editors underneath a modal or another pane.
            if (hit && !target.current?.contains(hit)) return;
            if (
              bounds &&
              x >= bounds.left &&
              x <= bounds.right &&
              y >= bounds.top &&
              y <= bounds.bottom
            )
              receive.current(payload.paths, { x, y });
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
