import { Component, createRef, type ReactNode } from "react";
import { arrive, exitDuration, leave } from "./arrive";

type Props = {
  /** Names the page on show; a new value is a switch of pages. */
  page: string;
  children: ReactNode;
};

/** A page that was on show before the switch: where it was and what it looked like. */
type Departing = {
  left: number;
  top: number;
  width: number;
  height: number;
  image: HTMLElement;
};

/**
 * Switching pages (DESIGN.md section 12). The pages inside come and go in two
 * ways: some stay mounted and toggle `hidden`, others mount per visit. Either
 * way the old page is gone from the document by the time the new one commits,
 * so this region keeps a picture of it: before React updates the DOM it copies
 * what is on show, and afterwards lays the copy over the panel to fade out
 * (150ms, slight blur) while the new page waits that long and then fades up.
 * The copy is only a picture: inert, hidden from assistive technology, without
 * ids, and it never takes the pointer.
 *
 * It is a layout-free wrapper (`display: contents`), so pages lay out exactly
 * as they would without it. With reduced motion, or while a key repeats or
 * clicks are rapid, there is no exit and no wait: the page just changes.
 */
export class ViewRegion extends Component<Props> {
  private region = createRef<HTMLDivElement>();

  getSnapshotBeforeUpdate(previous: Props): Departing[] | null {
    const region = this.region.current;
    if (previous.page === this.props.page || !region) return null;
    if (exitDuration() === 0 || typeof region.animate !== "function")
      return null;
    const panel = region.parentElement;
    if (!panel) return null;
    const origin = panel.getBoundingClientRect();
    const departing: Departing[] = [];
    for (const page of region.children) {
      if (!(page instanceof HTMLElement) || page.getClientRects().length === 0)
        continue;
      const box = page.getBoundingClientRect();
      const image = page.cloneNode(true) as HTMLElement;
      // Scrolled lists keep their place in the picture. Both trees are walked
      // in the same order, before the DOM changes.
      const from = [page, ...page.querySelectorAll<HTMLElement>("*")];
      const to = [image, ...image.querySelectorAll<HTMLElement>("*")];
      from.forEach((element, index) => {
        const copy = to[index];
        if (copy && (element.scrollTop || element.scrollLeft)) {
          copy.dataset.scrollTop = String(element.scrollTop);
          copy.dataset.scrollLeft = String(element.scrollLeft);
        }
      });
      departing.push({
        left: box.left - origin.left,
        top: box.top - origin.top,
        width: box.width,
        height: box.height,
        image,
      });
    }
    return departing;
  }

  componentDidUpdate(
    previous: Props,
    _state: unknown,
    departing: Departing[] | null,
  ) {
    const region = this.region.current;
    if (previous.page === this.props.page || !region) return;
    const panel = region.parentElement;
    if (panel && departing)
      for (const { image, ...box } of departing) show(panel, image, box);
    for (const page of region.children)
      if (page instanceof HTMLElement && page.getClientRects().length > 0)
        arrive(page, { delay: exitDuration() });
  }

  render() {
    return (
      <div ref={this.region} data-slot="view-region" className="view-region">
        {this.props.children}
      </div>
    );
  }
}

/** The departing page as a still picture over the panel, fading away. */
function show(
  panel: HTMLElement,
  image: HTMLElement,
  box: Pick<Departing, "left" | "top" | "width" | "height">,
) {
  const frame = document.createElement("div");
  frame.className = "view-departing";
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("inert", "");
  frame.style.cssText = `left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px`;
  for (const element of image.querySelectorAll("[id]"))
    element.removeAttribute("id");
  image.removeAttribute("id");
  frame.append(image);
  // Scrolling only takes once the copy is laid out.
  panel.append(frame);
  for (const element of [image, ...image.querySelectorAll<HTMLElement>("*")]) {
    const { scrollTop, scrollLeft } = element.dataset;
    if (scrollTop) element.scrollTop = Number(scrollTop);
    if (scrollLeft) element.scrollLeft = Number(scrollLeft);
  }
  leave(frame, () => frame.remove());
}
