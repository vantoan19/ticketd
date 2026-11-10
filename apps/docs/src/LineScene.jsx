import machines from "./LineMachines.markup.json";
import drawing from "./LineScene.markup.json";

// One drawing keeps the conveyor, machines and hit targets at the same scale.
export default function LineScene({ line }) {
  return (
    <div className="st-line" role="group" aria-label="Machines on the line">
      <svg
        className="x-art"
        viewBox={`0 0 ${drawing.width} ${drawing.height}`}
        data-hot={line.hot}
        data-step={line.step}
        data-run={line.running}
        data-d0={line.d0}
        data-d1={line.d1}
        data-d2={line.d2}
        data-d3={line.d3}
        data-d4={line.d4}
        aria-hidden="true"
      >
        <g dangerouslySetInnerHTML={{ __html: drawing.frame }} />
        {line.stations.map((station, i) => {
          const position = drawing.stations[i];
          return (
            <g key={station.num}>
              <g
                className="ln-v-machine"
                transform={`translate(${position.offsetX} ${position.offsetY})`}
                dangerouslySetInnerHTML={{ __html: machines[i].markup }}
              />
              <circle
                className="x-p x-i ln-v-port"
                data-on={station.on}
                cx={i % 2 === 0 ? 247 : 312}
                cy={position.beltY - 2}
                r="4"
                strokeWidth="1.2"
              />
              <text
                className="x-t2"
                x={position.left + position.width / 2}
                y={position.captionY}
                fontSize="10"
                textAnchor="middle"
              >
                {station.cmd}
              </text>
            </g>
          );
        })}
        <g
          className="ln-v-rider"
          style={{
            "--line-y": `${drawing.stations[Number(line.step)].beltY}px`,
          }}
          dangerouslySetInnerHTML={{ __html: drawing.rider }}
        />
      </svg>
      {line.stations.map((station, i) => {
        const position = drawing.stations[i];
        return (
          <button
            key={station.num}
            type="button"
            className="st-stn"
            style={{
              left: `${(position.left / drawing.width) * 100}%`,
              top: `${(position.top / drawing.height) * 100}%`,
              width: `${(position.width / drawing.width) * 100}%`,
              height: `${((position.height + 28) / drawing.height) * 100}%`,
            }}
            aria-label={station.label}
            aria-pressed={station.on}
            onClick={station.pick}
            onMouseEnter={station.hot}
            onFocus={station.hot}
            onMouseLeave={line.cold}
            onBlur={line.cold}
          >
            <span className="st-tip">ticketd {station.cmd}</span>
          </button>
        );
      })}
    </div>
  );
}
