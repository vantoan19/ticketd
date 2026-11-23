import { At, Label, Line, Plate, paint } from "./primitives.tsx";
import { Beacon, Rail, Ticket, Walk } from "./objects.tsx";
import type { Station } from "./world-layout.ts";

/** Each scene has an approach, bolted foundations, an inclined stair and a
 * loading edge. Their west junction is the shared origin for the long route. */
export function WaysideModel({
  name,
  index,
}: {
  name: Station;
  index: number;
}) {
  return (
    <>
      <Walk p={[-43, 57, 0]} w={80} d={28} h={3} />
      <Rail p={[-40, 58, 3]} length={33} h={8} />
      <At p={[-16, 56, 3]}>
        {[0, 1, 2, 3].map((i) => (
          <Plate key={i} x={i * 4} w={4} d={30} h={2 + i * 2} />
        ))}
      </At>
      <use href={"#station-" + index} />
      {name === "Plan" && (
        <g opacity="var(--parked-ticket, 1)">
          <Ticket p={[11, 64, 13]} w={40} d={24} refId="T-12" active />
        </g>
      )}
      <At p={[62, 95, 0]}>
        <Plate x={2} y={5} w={72} d={19} h={3} shadow />
        <Plate x={7} y={8} z={3} w={3} d={3} h={10} />
        <Plate x={64} y={8} z={3} w={3} d={3} h={10} />
        <Plate x={4} y={7} z={12} w={68} d={4} h={12}>
          <Label p={[9, 11, 15]} size={7.5} plane="left">
            {["Plan flow", "Agent dock", "Inbox", "Rule flow"][index]}
          </Label>
        </Plate>
      </At>
      <Beacon p={[-27, 79, 3]} h={12} />
      <Line
        points={[
          [4, 98, 13],
          [12, 98, 13],
          [12, 96, 13],
          [16, 99, 13],
          [12, 101, 13],
        ]}
        weight="fine"
        color={paint.blue}
      />
    </>
  );
}
