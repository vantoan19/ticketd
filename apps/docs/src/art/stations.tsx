import { At, Dot, Label, Line, Outline, paint, Plate } from "./primitives.tsx";
import type { Station } from "./world-layout.ts";
import {
  AgentCart,
  Beacon,
  Gate,
  Person,
  Rail,
  Spec,
  Terrace,
  Ticket,
} from "./objects.tsx";

function PlanStation() {
  return (
    <>
      <Terrace
        p={[0, 0, 0]}
        w={150}
        d={103}
        h={13}
        title="Plan  /  Login hardening"
      />
      <Spec p={[8, 5, 13]} w={91} h={50} />
      <Plate x={108} y={8} z={13} w={29} d={21} h={3} shadow />
      <Plate x={109} y={7} z={16} w={29} d={21} h={2}>
        <Label p={[113, 20, 18]} size={6}>
          SPEC
        </Label>
      </Plate>
      <Line
        points={[
          [38, 65, 13],
          [38, 78, 13],
          [93, 78, 13],
          [93, 68, 13],
        ]}
        weight="fine"
        color={paint.blue}
      />
      <Dot p={[38, 76, 13]} r={1.8} />
      <Dot p={[93, 68, 13]} r={1.8} />
      <Ticket p={[11, 32, 13]} refId="T-9" w={40} d={24} />
      <Ticket p={[64, 32, 13]} refId="T-13" w={43} d={24} />
      <Outline x={10} y={64} z={13} w={43} d={26} dash="3 2" />
      <Ticket p={[70, 67, 13]} refId="T-14" w={43} d={24} />
      <Person p={[128, 76, 13]} />
    </>
  );
}

function DockStation() {
  return (
    <>
      <Terrace p={[0, 0, 0]} w={153} d={92} h={13} title="Agent dock" />
      <At p={[5, 2, 13]}>
        <Plate w={43} d={16} h={36} shadow>
          <Line
            points={[
              [5, 16, 9],
              [37, 16, 9],
              [37, 16, 30],
              [5, 16, 30],
              [5, 16, 9],
            ]}
            weight="fine"
          />
          <Label p={[8, 16, 20]} size={8} plane="left">
            CLI
          </Label>
          <Line
            points={[
              [8, 16, 15],
              [23, 16, 15],
            ]}
            weight="fine"
          />
        </Plate>
      </At>
      <Rail p={[64, 1, 13]} length={68} />
      <Outline x={64} y={12} z={13} w={59} d={39} dash="3 2" />
      <AgentCart p={[68, 16, 13]} label="Codex" />
      <Outline x={64} y={52} z={13} w={59} d={33} dash="3 2" />
      <Label p={[69, 72, 13]} size={8}>
        Claude Code
      </Label>
      <Line
        points={[
          [1, 62, 13],
          [36, 62, 13],
          [36, 24, 13],
        ]}
        weight="fine"
        color={paint.blue}
        dash="4 3"
      />
      <Beacon p={[134, 14, 13]} h={23} />
      <Person p={[35, 76, 13]} />
    </>
  );
}

function InboxStation() {
  return (
    <>
      <Terrace
        p={[0, 0, 0]}
        w={154}
        d={95}
        h={13}
        title="Inbox  /  Followed tickets"
      />
      <At p={[12, 8, 13]}>
        <Plate w={105} d={49} h={2} shadow />
        <Plate w={105} d={3} h={12} />
        <Plate w={3} d={49} h={12} />
        <Plate x={8} y={7} z={2} w={88} d={34} h={2} />
        <Plate x={10} y={6} z={4} w={88} d={34} h={2}>
          <Dot p={[15, 11, 6]} r={2.1} />
          <Label p={[20, 16, 6]} size={9}>
            Update
          </Label>
          {[40, 61, 48].map((len, i) => (
            <Line
              key={len}
              points={[
                [16, 23 + i * 4, 6],
                [16 + len, 23 + i * 4, 6],
              ]}
              weight="fine"
              color={paint.fine}
            />
          ))}
        </Plate>
        <Plate x={102} w={3} d={49} h={10} />
        <Plate y={46} w={105} d={3} h={5} />
      </At>
      <At p={[114, 7, 13]}>
        <Plate w={22} d={11} h={17} shadow />
        <Label p={[4, 11, 5]} size={7} plane="left">
          PR
        </Label>
      </At>
      <Beacon p={[138, 15, 13]} h={25} />
      <Plate x={22} y={68} z={13} w={51} d={16} h={2}>
        <Label p={[25, 78, 15]} size={7}>
          Evidence
        </Label>
      </Plate>
      <At p={[84, 65, 13]}>
        <Plate w={25} d={16} h={1} />
        <Plate x={2} y={-1} z={1} w={25} d={16} h={1} />
        <Line
          points={[
            [6, 4, 2],
            [22, 4, 2],
          ]}
          weight="fine"
        />
        <Line
          points={[
            [6, 8, 2],
            [17, 8, 2],
          ]}
          weight="fine"
        />
      </At>
      <Person p={[116, 67, 13]} />
    </>
  );
}

function AutomationStation() {
  return (
    <>
      <Terrace p={[0, 0, 0]} w={147} d={101} h={13} title="Automation" />
      <Plate x={12} y={12} z={13} w={117} d={72} h={3} shadow>
        <Outline x={17} y={17} z={16} w={107} d={62} />
        <Outline x={35} y={34} z={16} w={70} d={29} />
        <Line
          points={[
            [42, 26, 16],
            [73, 26, 16],
            [69, 23, 16],
            [73, 26, 16],
            [68, 29, 16],
          ]}
          color={paint.blue}
        />
        <Line
          points={[
            [85, 71, 16],
            [57, 71, 16],
            [62, 68, 16],
            [57, 71, 16],
            [62, 74, 16],
          ]}
          color={paint.blue}
        />
      </Plate>
      <Gate p={[32, 20, 16]} w={31} h={23} label="If" />
      <Beacon p={[114, 25, 16]} h={34} />
      <At p={[47, 45, 16]}>
        <Plate w={25} d={15} h={15} />
        <Label p={[3, 15, 4]} plane="left" size={8}>
          Run
        </Label>
      </At>
      <Plate x={18} y={58} z={16} w={19} d={16} h={5} tone="dark" />
      <Person p={[127, 77, 13]} />
    </>
  );
}

export function StationModel({ name }: { name: Station }) {
  switch (name) {
    case "Plan":
      return <PlanStation />;
    case "Hand off":
      return <DockStation />;
    case "Follow":
      return <InboxStation />;
    case "Automate":
      return <AutomationStation />;
  }
}

export function ReviewDeck() {
  return (
    <>
      <Terrace p={[0, 0, 0]} w={145} d={93} h={13} title="Review" />
      <Gate p={[13, 19, 13]} w={61} label="In review" />
      <Ticket p={[18, 27, 13]} refId="T-9" w={45} d={29} />
      {[0, 1, 2].map((i) => (
        <Ticket key={i} p={[89, 15, 13 + i * 4]} refId="T-11" w={40} d={27} />
      ))}
      <Label p={[91, 53, 13]} size={13}>
        Done
      </Label>
      <Rail p={[83, 85, 13]} length={53} />
      <Person p={[61, 69, 13]} />
    </>
  );
}
