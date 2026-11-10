import { useEffect, useRef } from "react";
import drawing from "./LineScene.markup.json";

// One drawing keeps the conveyor, machines and hit targets at the same scale.
export default function LineScene({ line }) {
  const conveyor = useRef(null);
  useEffect(() => {
    const viewport = conveyor.current;
    if (
      !viewport ||
      viewport.firstElementChild.clientWidth <= viewport.clientWidth
    )
      return;
    const station = viewport.querySelector('[aria-pressed="true"]');
    if (!station) return;
    viewport.scrollTo({
      left:
        station.offsetLeft + station.offsetWidth / 2 - viewport.clientWidth / 2,
      behavior: "instant",
    });
  }, [line.step]);

  return (
    <div className="st-line" ref={conveyor}>
      <div
        className="st-line-track"
        role="group"
        aria-label="Machines on the line"
      >
        <svg
          className="x-art"
          viewBox={drawing.viewBox}
          style={{ "--rx": `${Number(line.step) * 206}px` }}
          data-hot={line.hot}
          data-step={line.step}
          data-run={line.running}
          data-d0={line.d0}
          data-d1={line.d1}
          data-d2={line.d2}
          data-d3={line.d3}
          data-d4={line.d4}
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: drawing.markup }}
        />
        {line.stations.map((station, i) => {
          const position = drawing.stations[i];
          return (
            <button
              key={station.num}
              type="button"
              className="st-stn"
              style={{
                left: `${(position.left / drawing.width) * 100}%`,
                top: `${((position.top - drawing.top) / drawing.height) * 100}%`,
                width: `${(position.width / drawing.width) * 100}%`,
                height: `${(position.height / drawing.height) * 100}%`,
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
    </div>
  );
}
