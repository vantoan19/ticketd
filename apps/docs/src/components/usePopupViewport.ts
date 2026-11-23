import { useLayoutEffect } from "react";

/** Pin open controls to the visible part of the page as a reader pinches,
 * pans, rotates the device or opens its software keyboard. */
export function usePopupViewport(popup: HTMLElement | null) {
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    if (!popup || !viewport) return;
    const fit = () => {
      popup.style.setProperty("--viewport-width", viewport.width + "px");
      popup.style.setProperty("--viewport-height", viewport.height + "px");
      popup.style.setProperty("--viewport-top", viewport.offsetTop + "px");
      popup.style.setProperty("--viewport-scale", String(viewport.scale));
      popup.style.setProperty(
        "--viewport-center",
        viewport.offsetLeft + viewport.width / 2 + "px",
      );
      popup.toggleAttribute("data-short-viewport", viewport.height < 240);
      popup.toggleAttribute("data-magnified", viewport.scale > 1.01);
    };
    fit();
    viewport.addEventListener("resize", fit);
    viewport.addEventListener("scroll", fit);
    return () => {
      viewport.removeEventListener("resize", fit);
      viewport.removeEventListener("scroll", fit);
    };
  }, [popup]);
}
