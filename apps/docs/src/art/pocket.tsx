import { At, Dot, Label, Line, Outline, paint, Plate } from "./primitives.tsx";
import {
  AgentCart,
  Beacon,
  Gate,
  Person,
  Rail,
  Spec,
  Terrace,
  Ticket,
  Walk,
} from "./objects.tsx";

/** A shorter raised loop built around thumb-sized landmarks. The upright spec,
 * CLI dock, inbox tray and rule gate retain their silhouettes beside a phone display. */
export function PocketWorld() {
  return (
    <g id="pocket">
      <Terrace p={[-116, -110, -7]} w={231} d={221} h={7} grid />
      {[-58, 57].map((x) => (
        <At key={x} p={[x, -x, 0]}>
          <Plate x={-5} y={-3} w={11} d={9} h={2} shadow />
          <Plate x={-2} z={2} w={5} d={4} h={45} />
        </At>
      ))}
      <Terrace p={[-82, -77, 0]} w={164} d={158} h={9} />
      <Walk p={[-82, -77, 9]} w={164} d={24} h={4} />
      <Walk p={[-82, -53, 9]} w={24} d={109} h={4} axis="y" />
      <Walk p={[58, -53, 9]} w={24} d={109} h={4} axis="y" />
      <Walk p={[-82, 56, 9]} w={164} d={25} h={4} />
      <At p={[-114, 50, 0]}>
        <Plate w={45} d={43} h={4} shadow />
        <Spec p={[1, 0, 4]} w={42} h={29} title="Plan" />
        <Ticket p={[4, 15, 4]} w={19} d={12} refId="T-9" />
        <Ticket p={[22, 28, 4]} w={19} d={12} refId="T-13" />
        <Line
          points={[
            [13, 28, 4],
            [13, 34, 4],
            [22, 34, 4],
          ]}
          color={paint.blue}
          weight="fine"
        />
      </At>
      <At p={[52, -109, 0]}>
        <Plate w={48} d={29} h={4} shadow />
        <Gate p={[2, 0, 4]} w={34} h={21} label="Review" />
        <Ticket p={[18, 19, 4]} refId="T-11" w={22} d={14} />
        <Ticket p={[18, 19, 8]} refId="T-11" w={22} d={14} />
      </At>
      <At p={[-13, -4, 9]}>
        <Plate w={53} d={33} h={3} shadow />
        <Outline x={4} y={4} z={3} w={45} d={25} />
        <Outline x={15} y={12} z={3} w={22} d={10} />
        <Gate p={[8, 8, 3]} w={17} h={14} label="If" />
        <Plate x={31} y={16} z={3} w={10} d={7} h={3} tone="dark" />
        <Beacon p={[46, 4, 3]} h={13} />
      </At>
      <At p={[-30, 82, 0]}>
        <Plate w={59} d={23} h={4} shadow />
        <Plate x={1} y={2} z={4} w={17} d={4} h={15}>
          <Label p={[3, 6, 8]} size={6} plane="left">
            CLI
          </Label>
        </Plate>
        <Outline x={25} y={3} z={4} w={28} d={17} dash="2 2" />
        <At p={[28, 5, 4]}>
          <g transform="scale(.45)">
            <AgentCart label="Codex" />
          </g>
        </At>
        <Label p={[4, 23, 0.8]} plane="left" size={3.8}>
          Agent dock
        </Label>
      </At>
      <At p={[83, -20, 0]}>
        <Plate w={28} d={36} h={5} shadow />
        <Plate x={2} y={4} z={5} w={24} d={26} h={2} />
        <Ticket p={[4, 5, 7]} refId="Inbox" w={20} d={17} />
        <Dot p={[8, 8, 11]} r={1.6} />
        <Plate x={2} y={27} z={7} w={24} d={3} h={3} />
      </At>
      <Rail p={[83, 22, 9]} length={22} axis="y" h={6} />
      <At p={[54, 81, 0]}>
        {[0, 1, 2, 3].map((i) => (
          <Plate key={i} y={i * 4} w={24} d={4} h={12 - i * 3} />
        ))}
      </At>
      <Walk p={[54, 97, 0]} w={24} d={14} h={2} axis="y" />
      <Person p={[41, 98, 0]} />
    </g>
  );
}
