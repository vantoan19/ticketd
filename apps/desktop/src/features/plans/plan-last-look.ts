import { useEffect, useLayoutEffect, useRef } from "react";
import { loadPreferences, setPreference } from "@/lib/preferences";

function rememberLastLook(id: string) {
  const { planLastLook } = loadPreferences();
  setPreference("planLastLook", {
    ...planLastLook,
    [id]: new Date().toISOString(),
  });
}

/** Advance the cutoff on a committed departure from the visible Plan scope. */
export function usePlanLastLook(visiblePlan: string) {
  const previous = useRef("");
  useLayoutEffect(() => {
    const left = previous.current;
    previous.current = visiblePlan;
    // A hidden workspace remains mounted. StrictMode also replays effects, so
    // an effect cleanup does not tell us whether the person left the Plan.
    if (left && left !== visiblePlan) rememberLastLook(left);
  }, [visiblePlan]);

  useEffect(() => {
    function leavingPage() {
      if (previous.current) rememberLastLook(previous.current);
    }
    window.addEventListener("pagehide", leavingPage);
    return () => window.removeEventListener("pagehide", leavingPage);
  }, []);
}
