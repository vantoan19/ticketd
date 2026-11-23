import {
  useCallback,
  useState,
  useSyncExternalStore,
  type FocusEvent,
  type SyntheticEvent,
} from "react";

const subscribe = () => () => {};
const browser = () => true;
const server = () => false;

/** The server and first hydration render agree before browser preferences or controls take over. */
export function useHydrated() {
  return useSyncExternalStore(subscribe, browser, server);
}

function readingNativeControl(element: HTMLElement, focus: EventTarget | null) {
  return (
    (focus instanceof Node && element.contains(focus)) ||
    element.matches("details[open]") ||
    !!element.querySelector("details[open]")
  );
}

/** A visitor can open or focus the HTML controls before the app downloads.
 * Upgrade this group when they finish, preserving the link or disclosure in use. */
export function useProgressiveControls() {
  const hydrated = useHydrated();
  const [reading, setReading] = useState(false);
  const inspect = useCallback((element: HTMLElement | null) => {
    if (element)
      setReading(
        readingNativeControl(element, element.ownerDocument.activeElement),
      );
  }, []);
  const interactive = hydrated && !reading;
  return {
    interactive,
    nativeProps: interactive
      ? {}
      : {
          ref: inspect,
          onFocusCapture: () => setReading(true),
          onBlurCapture: (event: FocusEvent<HTMLElement>) =>
            setReading(
              readingNativeControl(event.currentTarget, event.relatedTarget),
            ),
          onToggleCapture: (event: SyntheticEvent<HTMLElement>) =>
            inspect(event.currentTarget),
        },
  };
}
