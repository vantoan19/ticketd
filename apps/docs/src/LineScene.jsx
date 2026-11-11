import { useEffect, useRef } from "react";
import drawing from "./LineScene.markup.json";

// Keep the active machine in view while the visible stage controls stay below the drawing.
export default function LineScene({ line }) {
  const conveyor = useRef(null);
  useEffect(() => {
    const viewport = conveyor.current;
    if (
      !viewport ||
      viewport.firstElementChild.clientWidth <= viewport.clientWidth
    )
      return;
    const station = drawing.stations[Math.max(0, Number(line.step))];
    if (!station) return;
    const scale = viewport.firstElementChild.clientWidth / drawing.width;
    viewport.scrollTo({
      left:
        (station.left + station.width / 2) * scale - viewport.clientWidth / 2,
      behavior: "instant",
    });
  }, [line.step]);

  return (
    <div className="st-line-scene">
      <div className="st-line" ref={conveyor}>
        <div className="st-line-track">
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
        </div>
      </div>
      <div
        className="st-control-row st-line-stages"
        role="group"
        aria-label="Stages on the line"
      >
        {line.stations.map((station) => (
          <button
            key={station.num}
            type="button"
            aria-pressed={station.on}
            onClick={station.pick}
          >
            <span>{station.num}</span> {station.name}
          </button>
        ))}
      </div>
    </div>
  );
}
