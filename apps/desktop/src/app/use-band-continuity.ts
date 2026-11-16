import { useEffect, useState } from "react";

const overlay =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [data-slot="popover-content"]';

/** Layout belongs to the current reading session, not the async failure's lifetime. */
export function useBandContinuity(
  hasBand: boolean,
  pane: HTMLElement | null,
  navigation: string,
) {
  const [pointerInside, setPointerInside] = useState(false);
  const [layout, setLayout] = useState({
    navigation,
    observed: hasBand,
    reserved: hasBand,
  });
  if (layout.observed !== hasBand) {
    const focused = pane?.contains(document.activeElement) ?? false;
    const hovered = pane?.matches(":hover") ?? false;
    setLayout({
      navigation,
      observed: hasBand,
      reserved:
        layout.reserved || (hasBand && !focused && !hovered && !pointerInside),
    });
  } else if (layout.navigation !== navigation && (layout.reserved || hasBand)) {
    setLayout({ navigation, observed: hasBand, reserved: hasBand });
  }
  useEffect(() => {
    if (!pane) return;
    const commit = () =>
      setLayout((current) =>
        current.reserved === current.observed
          ? current
          : { ...current, reserved: current.observed },
      );
    const insideOverlay = (target: EventTarget | null) =>
      target instanceof Element && Boolean(target.closest(overlay));
    const enter = () => {
      setPointerInside(true);
    };
    const leave = (event: PointerEvent) => {
      if (!event.relatedTarget || insideOverlay(event.relatedTarget)) return;
      setPointerInside(false);
      if (!pane.contains(document.activeElement)) commit();
    };
    const focus = (event: FocusEvent) => {
      // Disabling a field can leave BODY focused. That is not a person's departure.
      if (
        event.target === document.body ||
        event.target === document.documentElement ||
        insideOverlay(event.target)
      )
        return;
      if (!pane.contains(event.target as Node) && !pointerInside) commit();
    };
    const press = (event: PointerEvent) => {
      if (
        !pane.contains(event.target as Node) &&
        !insideOverlay(event.target)
      ) {
        setPointerInside(false);
        commit();
      }
    };
    pane.addEventListener("pointerenter", enter);
    pane.addEventListener("pointerleave", leave);
    document.addEventListener("focusin", focus);
    document.addEventListener("pointerdown", press, true);
    return () => {
      pane.removeEventListener("pointerenter", enter);
      pane.removeEventListener("pointerleave", leave);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("pointerdown", press, true);
    };
  }, [pane, pointerInside]);
  return layout.reserved;
}
