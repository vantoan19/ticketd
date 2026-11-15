import { useEffect } from "react";

/**
 * Records on <html data-input="pointer|keyboard"> how the user last
 * interacted. CSS hides focus rings for "pointer", so a click leaves no stale
 * ring (even when focus is later moved by code), while keyboard focus always
 * shows one. Text fields keep their ring either way. Focus is an outline, and
 * the reset clears only outline, so elevation and edges drawn with box-shadow
 * survive a click.
 */
export function useInputModality() {
  useEffect(() => {
    const root = document.documentElement;
    const set = (value: "pointer" | "keyboard") => () => {
      root.dataset.input = value;
    };
    const pointer = set("pointer");
    const keyboard = (event: KeyboardEvent) => {
      // Shortcuts held with a modifier are not navigation.
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      root.dataset.input = "keyboard";
    };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("keydown", keyboard, true);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("keydown", keyboard, true);
      delete root.dataset.input;
    };
  }, []);
}
