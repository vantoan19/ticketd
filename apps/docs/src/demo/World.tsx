import { createRef, useEffect, useRef, useState } from "react";
import sprite from "virtual:ticketd-art";
import {
  scenes,
  stationNames,
  stationStops,
  type Composition,
} from "../art/world-layout";
import { project, round } from "../art/geometry";
import { onWorld, type Pose } from "./vehicle";
import { stages, type Stage } from "./workspace";

const closingLabelSize = { wide: 16.5, tablet: 16, pocket: 15.5 };

function transform({ position: [x, y], scale }: Pose) {
  return "translate(" + round(x) + " " + round(y) + ") scale(" + scale + ")";
}

function createVehicle(type: Composition, stage: Stage) {
  return {
    type,
    initial: onWorld(scenes[type], stationStops[stage]),
    cart: createRef<SVGGElement>(),
    ticket: createRef<SVGGElement>(),
  };
}

/** All three floor plans follow the same journey time. Rotating a phone during
 * a turn reveals the cart at the same point on the newly visible walkway. */
function useWorldVehicles(stage: Stage, still: boolean) {
  const [vehicles] = useState(() =>
    (["wide", "tablet", "pocket"] as const).map((type) =>
      createVehicle(type, stage),
    ),
  );
  const cursor = useRef<number>(stationStops[stage]);
  useEffect(() => {
    const end = stationStops[stage];
    if (cursor.current === end) return;
    const place = (position: number) => {
      for (const vehicle of vehicles) {
        const pose = onWorld(scenes[vehicle.type], position);
        vehicle.cart.current?.setAttribute("transform", transform(pose.cart));
        vehicle.ticket.current?.setAttribute(
          "transform",
          transform(pose.ticket),
        );
      }
      cursor.current = position;
    };
    if (still || !window.requestAnimationFrame) {
      place(end);
      return;
    }
    // The scroll route takes the load from its exact current pose. Keep that
    // pose parked until the visitor returns the ticket to the hero.
    const story = vehicles[0]!.cart.current?.closest(".landing-story");
    let frame = 0;
    const follow = () => {
      cancelAnimationFrame(frame);
      const start = cursor.current;
      if (start === end || story?.hasAttribute("data-travel")) return;
      const duration = Math.min(1600, 420 + Math.abs(end - start) * 210),
        began = performance.now();
      const tick = (time: number) => {
        const t = Math.min(1, (time - began) / duration);
        place(start + (end - start) * (t * t * (3 - 2 * t)));
        if (t < 1) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    };
    story?.addEventListener("ticketd-travel", follow);
    follow();
    return () => {
      cancelAnimationFrame(frame);
      story?.removeEventListener("ticketd-travel", follow);
    };
  }, [stage, still, vehicles]);
  return vehicles;
}

function Vehicle({
  vehicle: { type, initial, cart, ticket },
  closing,
}: {
  vehicle: ReturnType<typeof createVehicle>;
  closing: boolean;
}) {
  return (
    <g className={closing ? "arrival-vehicle" : "hero-vehicle"}>
      <g data-carriage="" ref={cart} transform={transform(initial.cart)}>
        <use href={sprite + "#empty-cart"} />
      </g>
      <g data-load="" ref={ticket} transform={transform(initial.ticket)}>
        <use href={sprite + "#done-ticket"} />
        {closing && (
          <g
            transform={`translate(13 -14) scale(${1 / scenes[type].doneScale})`}
          >
            <path d="M0 6V-7" fill="none" stroke="var(--blue)" />
            <rect
              x="-27"
              y="-27"
              width="54"
              height="21"
              rx="5"
              fill="var(--blue)"
            />
            <text
              x="0"
              y="-11"
              fontSize={closingLabelSize[type]}
              fontWeight="600"
              textAnchor="middle"
              fill="var(--on-blue)"
            >
              Done
            </text>
          </g>
        )}
      </g>
    </g>
  );
}

function MapSign({
  i,
  active,
  closing,
  type,
}: {
  i: number;
  active: boolean;
  closing: boolean;
  type: Composition;
}) {
  const [x, y] = project(scenes[type].markers[i]!);
  const size = closing ? closingLabelSize[type] : type === "pocket" ? 8 : 10.5;
  const tag =
    closing || active ? stationNames[i]! : String(i + 1).padStart(2, "0");
  const w = Math.max(
    type === "pocket" ? 15 : 22,
    tag.length * size * 0.63 + (closing ? 15 : 10),
  );
  const h = size + (closing ? 7 : 5);
  return (
    <g
      transform={"translate(" + round(x) + " " + round(y) + ")"}
      className="map-label"
    >
      <rect
        x={-w / 2}
        width={w}
        height={h}
        rx={h / 2}
        fill={active && !closing ? "var(--blue)" : "var(--face-top)"}
        stroke={active && !closing ? "var(--blue)" : "var(--drawing-ink)"}
        strokeWidth={0.85}
      />
      <text
        y={h / 2 + size * 0.34}
        style={{ fontSize: size }}
        textAnchor="middle"
        fill={active && !closing ? "var(--on-blue)" : "var(--drawing-ink)"}
      >
        {tag}
      </text>
    </g>
  );
}

export function World({
  stage,
  still = false,
  closing = false,
}: {
  stage: Stage;
  still?: boolean;
  closing?: boolean;
}) {
  const vehicles = useWorldVehicles(stage, closing || still);
  return (
    <>
      {vehicles.map((vehicle) => {
        const type = vehicle.type,
          scene = scenes[type],
          dock = closing ? scene.entry : scene.exit;
        return (
          <svg
            key={type}
            className={"world-" + type}
            data-composition={type}
            viewBox={scene.viewBox}
            role="img"
            aria-label={
              closing
                ? "The four stations at rest. The blue ticket T-12 is stacked in Done."
                : "A raised isometric walkway connects the Plan, agent dock, Inbox and Automation. " +
                  stages[stage].worldDescription
            }
          >
            <g
              data-deck=""
              transform={
                "translate(" +
                scene.origin.join(" ") +
                ") scale(" +
                scene.scale +
                ")"
              }
            >
              <use href={sprite + "#" + scene.deck} />
              {stationNames.map((name, i) => (
                <MapSign
                  key={name}
                  i={i}
                  active={stage === i}
                  closing={closing}
                  type={type}
                />
              ))}
              <circle
                data-route-point={closing ? "arrival" : "departure"}
                cx={dock[0]}
                cy={dock[1]}
                r={1}
                fill="none"
              />
              <Vehicle vehicle={vehicle} closing={closing} />
            </g>
          </svg>
        );
      })}
    </>
  );
}
