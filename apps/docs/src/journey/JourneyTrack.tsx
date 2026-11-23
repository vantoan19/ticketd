import { useEffect, useRef, useState, type RefObject } from "react";
import sprite from "virtual:ticketd-art";
import { round, type Point } from "../art/geometry";
import type { Pose } from "../demo/vehicle";
import { RoadDeck } from "./RoadDeck";
import { routeLeg, type Leg } from "./route";
import { arrive, depart, onRoad, measureDock, type Dock } from "./travel";

interface Layout {
  width: number;
  height: number;
  top: number;
  phone: boolean;
  legs: Leg[];
  start: Dock;
  finish: Dock;
}
function measure(story: HTMLElement): Layout | null {
  const bounds = story.getBoundingClientRect();
  const docks = Array.from(story.querySelectorAll("[data-route-point]"))
    .map((element) => ({ element, box: element.getBoundingClientRect() }))
    .filter(({ box }) => box.width > 0 && box.height > 0);
  if (docks.length < 2) return null;
  const start = measureDock(docks[0]!.element, bounds),
    finish = measureDock(docks.at(-1)!.element, bounds);
  if (!start || !finish) return null;
  const points = docks.map(({ box }): Point => [
    box.left + box.width / 2 - bounds.left,
    box.top + box.height / 2 - bounds.top,
  ]);
  const phone = window.matchMedia("(max-width: 759px)").matches;
  const guide = story.querySelector(".journey-guide");
  const legend = guide?.firstElementChild?.getBoundingClientRect();
  const links = guide?.lastElementChild?.getBoundingClientRect();
  const passage: Point | undefined =
    !phone && legend && links && links.left > legend.right
      ? [
          (legend.right + links.left) / 2 - bounds.left,
          (legend.top + legend.bottom) / 2 - bounds.top,
        ]
      : undefined;
  return {
    width: bounds.width,
    height: bounds.height,
    top: bounds.top + scrollY,
    start,
    finish,
    phone,
    legs: points
      .slice(1)
      .map((p, i) =>
        routeLeg(
          points[i]!,
          p,
          bounds.width,
          phone,
          i === 0 ? passage : undefined,
        ),
      ),
  };
}
function transform({ position: [x, y], scale }: Pose) {
  return (
    "translate3d(" + round(x) + "px," + round(y) + "px,0) scale(" + scale + ")"
  );
}

/** Geometry is measured on layout changes. A scroll frame only moves the cart
 * and its load. The same physical ticket can be followed forwards or backwards. */
export function JourneyTrack({
  story,
}: {
  story: RefObject<HTMLElement | null>;
}) {
  const [layout, setLayout] = useState<Layout | null>(null);
  const cart = useRef<HTMLDivElement>(null),
    ticket = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = story.current;
    if (!root || typeof ResizeObserver === "undefined" || !window.matchMedia)
      return;
    const determine = () => {
      const measured = measure(root);
      root.toggleAttribute("data-route-measured", measured !== null);
      setLayout(measured);
    };
    const observer = new ResizeObserver(determine);
    observer.observe(root);
    root
      .querySelectorAll(
        ".hero-installation,.journey-guide > *,.journey-stop,.destination",
      )
      .forEach((n) => observer.observe(n));
    determine();
    return () => {
      observer.disconnect();
      root.removeAttribute("data-route-measured");
    };
  }, [story]);
  useEffect(() => {
    const root = story.current,
      carriage = cart.current,
      load = ticket.current;
    if (!layout || !root || !carriage || !load || !window.requestAnimationFrame)
      return;
    const route = layout,
      viewport = window.visualViewport,
      reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const first = route.legs[0]![0][1],
      last = route.legs.at(-1)!.at(-1)![1];
    const departureLength = route.phone
        ? 88
        : Math.min(275, route.width * 0.19),
      arrivalLength = route.phone ? 88 : 135;
    const scale = route.phone ? 0.44 : 0.74;
    let initial: ReturnType<typeof depart> | undefined;
    let frame = 0;
    function setTravel(phase: "moving" | "done" | undefined) {
      if (root!.dataset.travel === phase) return;
      if (phase) root!.dataset.travel = phase;
      else delete root!.dataset.travel;
      root!.dispatchEvent(new Event("ticketd-travel"));
    }
    const place = () => {
      frame = 0;
      // A pinch can move the visible window independently of the document.
      const top = viewport?.pageTop ?? scrollY;
      const y = top - route.top + (viewport?.height ?? innerHeight) * 0.67;
      if (reduced.matches || top <= 1 || y <= first - departureLength) {
        initial = undefined;
        setTravel(undefined);
        return;
      }
      if (y >= last + arrivalLength) {
        setTravel("done");
        return;
      }
      initial ??= depart(route.start, scale);
      let pose;
      if (y < first) pose = initial(1 - (first - y) / departureLength);
      else if (y >= last)
        pose = arrive(route.finish, scale, (y - last) / arrivalLength);
      else {
        const leg = route.legs.find((s) => s.at(-1)![1] >= y)!;
        pose = onRoad(
          leg,
          (y - leg[0][1]) / Math.max(1, leg.at(-1)![1] - leg[0][1]),
          scale,
        );
      }
      carriage.style.transform = transform(pose.cart);
      load.style.transform = transform(pose.ticket);
      setTravel("moving");
    };
    const tick = () => {
      if (!frame) frame = requestAnimationFrame(place);
    };
    const returnToGuide = (event: Event) => {
      if (event.target instanceof Element && event.target.closest(".monitor")) {
        cancelAnimationFrame(frame);
        frame = 0;
        initial = undefined;
        setTravel(undefined);
      }
    };
    window.addEventListener("scroll", tick, { passive: true });
    window.addEventListener("resize", tick);
    viewport?.addEventListener("scroll", tick, { passive: true });
    viewport?.addEventListener("resize", tick);
    reduced.addEventListener?.("change", tick);
    root.addEventListener("pointerdown", returnToGuide);
    root.addEventListener("focusin", returnToGuide);
    place();
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", tick);
      window.removeEventListener("resize", tick);
      viewport?.removeEventListener("scroll", tick);
      viewport?.removeEventListener("resize", tick);
      reduced.removeEventListener?.("change", tick);
      root.removeEventListener("pointerdown", returnToGuide);
      root.removeEventListener("focusin", returnToGuide);
      setTravel(undefined);
    };
  }, [layout, story]);
  return (
    layout && (
      <>
        <svg
          className="journey-track"
          aria-hidden="true"
          width={layout.width}
          height={layout.height}
        >
          {layout.legs.map((leg, i) => (
            <RoadDeck key={i} leg={leg} phone={layout.phone} />
          ))}
        </svg>
        <div className="travel-cart" aria-hidden="true">
          <div ref={cart}>
            <svg viewBox="-35 -32 88 85">
              <use href={sprite + "#empty-cart"} />
            </svg>
          </div>
          <div ref={ticket}>
            <svg viewBox="-35 -32 88 85">
              <use href={sprite + "#done-ticket"} />
            </svg>
          </div>
        </div>
      </>
    )
  );
}
