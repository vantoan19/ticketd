import { useCallback, useEffect, useRef, useState } from "react";
import {
  initializePageZoom,
  pageZoomLevels as levels,
  pageZoomPercent,
  setPageZoom,
} from "@/lib/page-zoom";
import { matchesShortcut } from "@/lib/shortcuts";

export type PageZoomAction =
  "page-zoom-in" | "page-zoom-out" | "page-zoom-reset";
type Outcome = { percent: number; error?: unknown };

/** One owner for native page zoom: keys and palette share the same request queue. */
export function usePageZoom() {
  const [percent, setPercent] = useState(pageZoomPercent);
  const [pending, setPending] = useState(() => "__TAURI_INTERNALS__" in window);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const applied = useRef(percent);
  const wanted = useRef(percent);
  const force = useRef(false);
  const initialization = useRef<Promise<void> | null>(null);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    if ("__TAURI_INTERNALS__" in window) {
      initialization.current = initializePageZoom().then((initial) => {
        if (!active) return;
        applied.current = initial;
        wanted.current = initial;
        setPercent(initial);
        setPending(false);
        initialization.current = null;
      });
    }
    return () => {
      active = false;
      mounted.current = false;
    };
  }, []);

  const request = useCallback(async (target: number, always = false) => {
    wanted.current = target;
    force.current ||= always;
    if (running.current || (target === applied.current && !force.current))
      return;
    running.current = true;
    setPending(true);
    try {
      // Only one IPC may be in flight. Coalesce intermediate keys, and always
      // finish at the latest target (especially a reset pressed during a request).
      while (
        mounted.current &&
        (wanted.current !== applied.current || force.current)
      ) {
        const next = wanted.current;
        force.current = false;
        try {
          await setPageZoom(next);
          applied.current = next;
          if (!mounted.current) return;
          setPercent(next);
        } catch (error) {
          // A newer queued target (especially Reset) still needs its own
          // native request when an older target fails.
          if (wanted.current !== next || force.current) continue;
          wanted.current = applied.current;
          if (mounted.current) setOutcome({ percent: next, error });
          return;
        }
      }
      if (mounted.current) setOutcome({ percent: applied.current });
    } finally {
      running.current = false;
      if (mounted.current) setPending(false);
    }
  }, []);

  const run = useCallback(
    (action: PageZoomAction) => {
      const apply = () => {
        if (!mounted.current) return;
        const index = levels.findIndex((level) => level === wanted.current);
        const target =
          action === "page-zoom-reset"
            ? 100
            : levels[
                Math.max(
                  0,
                  Math.min(
                    levels.length - 1,
                    index + (action === "page-zoom-in" ? 1 : -1),
                  ),
                )
              ];
        if (target !== undefined)
          void request(target, action === "page-zoom-reset");
      };
      if (initialization.current) void initialization.current.then(apply);
      else apply();
    },
    [request],
  );

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || !("__TAURI_INTERNALS__" in window)) return;
      const action = (
        ["page-zoom-in", "page-zoom-out", "page-zoom-reset"] as const
      ).find((id) => matchesShortcut(event, id));
      if (!action) return;
      // Capture intentionally includes fields, rich editors, dialogs and the
      // graph. Bare +/- remain the graph's own canvas keys. Tauri's native
      // hotkey polyfill is disabled so this event has exactly one zoom owner.
      event.preventDefault();
      event.stopPropagation();
      run(action);
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [run]);

  const retry = useCallback(
    (target: number) => request(target, true),
    [request],
  );
  return { percent, pending, outcome, run, retry };
}

export type PageZoom = ReturnType<typeof usePageZoom>;
