import { At, Label, Line, paint, Plate } from "./primitives.tsx";
import { Person, Rail, Spec, Terrace, Ticket } from "./objects.tsx";

export function DownloadModel() {
  return (
    <g id="download-model">
      <Terrace p={[0, 0, 0]} w={165} d={104} h={8} grid />
      <At p={[10, 6, 8]}>
        <Plate x={-2} y={-2} w={93} d={68} h={4} shadow />
        <Plate w={86} d={57} z={4} h={47} shadow>
          <Line
            points={[
              [5, 57, 10],
              [81, 57, 10],
              [81, 57, 45],
              [5, 57, 45],
              [5, 57, 10],
            ]}
            weight="fine"
          />
          <Label p={[13, 57, 29]} plane="left" size={13}>
            ticketd
          </Label>
          <Label p={[14, 57, 17]} plane="left" size={6}>
            Desktop
          </Label>
          <Line
            points={[
              [41, 0, 51],
              [41, 57, 51],
              [41, 57, 48],
            ]}
            color={paint.blue}
          />
          <Line
            points={[
              [47, 0, 51],
              [47, 57, 51],
              [47, 57, 48],
            ]}
            color={paint.blue}
          />
          <Line
            points={[
              [86, 11, 16],
              [86, 11, 38],
              [86, 6, 32],
              [86, 11, 38],
              [86, 16, 32],
            ]}
            weight="fine"
          />
        </Plate>
      </At>
      <At p={[92, 61, 8]}>
        <Plate w={54} d={28} h={5} shadow />
        <Plate x={3} y={2} z={5} w={46} d={22} h={13} tone="blue">
          <Label p={[7, 24, 8]} plane="left" color="var(--on-blue)" size={7}>
            CLI
          </Label>
        </Plate>
      </At>
      <Rail p={[110, 4, 8]} length={41} h={11} />
      <Person p={[148, 36, 8]} />
    </g>
  );
}
export function LedgerModel() {
  return (
    <g id="ledger-model">
      <Terrace p={[0, 0, 0]} w={158} d={104} h={8} grid />
      <At p={[25, 9, 8]}>
        <Spec w={92} h={56} title="Releases" />
      </At>
      <Plate x={23} y={47} z={8} w={90} d={44} h={3} shadow />
      {[0, 1, 2].map((i) => (
        <Plate
          key={i}
          x={26 - i}
          y={48 + i}
          z={11 + i * 2}
          w={79}
          d={32}
          h={2}
        />
      ))}
      <Line
        points={[
          [35, 61, 17],
          [82, 61, 17],
        ]}
        color={paint.fine}
      />
      <Line
        points={[
          [35, 66, 17],
          [72, 66, 17],
        ]}
        color={paint.fine}
      />
      <Ticket p={[112, 57, 8]} refId="log" w={34} d={23} active />
      <Person p={[139, 33, 8]} />
    </g>
  );
}
