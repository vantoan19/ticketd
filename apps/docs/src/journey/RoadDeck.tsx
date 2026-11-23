import { useMemo } from "react";
import sprite from "virtual:ticketd-art";
import { round } from "../art/geometry";
import { linePath, panelSeams, routeLegBridges, type Leg } from "./route";

export function RoadDeck({ leg, phone }: { leg: Leg; phone: boolean }) {
  const path = linePath(leg),
    weight = phone ? 9 : 20;
  const seams = useMemo(
    () => panelSeams(leg, phone ? 5.2 : 11.5, phone ? 26 : 36),
    [leg, phone],
  );
  const bridges = useMemo(() => routeLegBridges(leg, phone), [leg, phone]);
  return (
    <g strokeLinejoin="round" strokeLinecap="butt" fill="none">
      <path
        d={path}
        stroke="var(--cast-shadow)"
        strokeWidth={weight + 2}
        transform={phone ? "translate(2 3)" : "translate(4 7)"}
      />
      <path
        d={path}
        stroke="var(--drawing-fine)"
        strokeWidth={weight + 2}
        transform={phone ? "translate(0 1.5)" : "translate(0 3)"}
      />
      <path d={path} stroke="var(--drawing-fine)" strokeWidth={weight + 1.6} />
      <path d={path} stroke="var(--face-top)" strokeWidth={weight} />
      <path d={seams} stroke="var(--drawing-grid)" strokeWidth={1} />
      <path
        d={path}
        stroke="var(--blue)"
        strokeWidth={phone ? 0.65 : 1}
        strokeDasharray={phone ? "3 5" : "5 7"}
      />
      {bridges.map(({ at: [x, y], axis }, i) => (
        <use
          key={i}
          href={sprite + "#bridge-" + axis}
          transform={
            "translate(" +
            round(x) +
            " " +
            round(y) +
            ") scale(" +
            (phone ? 0.435 : 0.965) +
            ")"
          }
        />
      ))}
    </g>
  );
}
