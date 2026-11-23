import { useState } from "react";
import sprite from "virtual:ticketd-art";
import { stationIds as ids } from "../art/world-layout";
import { useProgressiveControls } from "../components/useHydrated";
import { CaptureLink } from "./ProductImage";
import { ProofScreen } from "./ProofScreen";
import { stationPin, stops, type Stop } from "./stops";

function Station({
  index,
  stop,
  selected,
}: {
  index: number;
  stop: Stop;
  selected: number;
}) {
  return (
    <svg
      viewBox="-120 -77 272 230"
      className="wayside-model"
      role="img"
      aria-label={
        stop.name +
        " station. " +
        stop.features[selected]!.name +
        " is marked on the model and desktop screen."
      }
    >
      <use href={sprite + "#wayside-" + index} />
      {stop.features.map((feature, i) => {
        if (stop.mode !== "notes" && i !== selected) return null;
        const { x, y, rise } = stationPin(feature, i);
        return (
          <g
            key={feature.name}
            transform={"translate(" + x + " " + y + ")"}
            className="model-pin"
            data-selected={i === selected}
          >
            <path d={"M0 0v-" + rise} stroke="var(--blue)" strokeWidth="1" />
            <circle r="1.8" fill="var(--blue)" />
            <circle
              cy={-rise}
              r="8"
              className="model-number"
              fill="var(--paper-raised)"
              stroke="var(--blue)"
              strokeWidth="1.2"
            />
            <text
              y={-rise}
              dy=".34em"
              textAnchor="middle"
              fontSize="11"
              fontWeight="600"
              fontFamily="var(--mono)"
              fill="var(--blue)"
            >
              {i + 1}
            </text>
          </g>
        );
      })}
      <circle data-route-point="" cx="-87" cy="11" r="1" fill="none" />
    </svg>
  );
}

function JourneyStop({ stop, index }: { stop: Stop; index: number }) {
  const { interactive, nativeProps } = useProgressiveControls();
  const [selected, setSelected] = useState(0);
  return (
    <section
      className="journey-stop site-width"
      id={ids[index]}
      data-side={index % 2 ? "left" : "right"}
      aria-labelledby={"stop-title-" + index}
    >
      <svg
        className="fallback-leg"
        viewBox="0 0 1150 600"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path
          d="M 860 -76 1000 6 215 459 460 600"
          fill="none"
          stroke="var(--line)"
          strokeWidth="12"
        />
        <path
          d="M 860 -76 1000 6 215 459 460 600"
          fill="none"
          stroke="var(--face-top)"
          strokeWidth="10"
        />
        <path
          d="M 860 -76 1000 6 215 459 460 600"
          fill="none"
          stroke="var(--blue)"
          strokeWidth="1"
          strokeDasharray="4 5"
        />
      </svg>
      <div className="stop-copy">
        <div className="stop-name">
          <span>{String(index + 1).padStart(2, "0")}</span>
          {stop.name}
        </div>
        <h2 id={"stop-title-" + index}>{stop.heading}</h2>
        <p>{stop.body}</p>
        <div
          {...nativeProps}
          role="group"
          className={
            "feature-list " +
            stop.mode +
            (interactive ? "" : " static-features")
          }
          aria-label={
            stop.name +
            (stop.mode === "commands"
              ? " commands"
              : stop.mode === "rules"
                ? " example rules"
                : " callouts")
          }
        >
          {stop.features.map((item, i) => {
            const label = (
              <>
                <span aria-hidden="true" className="feature-number">
                  {i + 1}
                </span>
                <span>
                  <strong>{item.name}</strong>
                  {stop.mode === "notes" && (
                    <span className="feature-note">{item.description}</span>
                  )}
                </span>
                {stop.mode !== "notes" && (
                  <span className="choice-arrow" aria-hidden="true">
                    ↗
                  </span>
                )}
              </>
            );
            return interactive ? (
              <button
                type="button"
                key={item.name}
                className="feature"
                aria-pressed={selected === i}
                onClick={() => setSelected(i)}
              >
                {label}
              </button>
            ) : (
              <details key={item.name} suppressHydrationWarning>
                <summary
                  className="feature"
                  data-initial={selected === i || undefined}
                >
                  {label}
                </summary>
                <div className="static-feature-body">
                  {item.command && <code>{item.command}</code>}
                  {stop.mode !== "notes" && <p>{item.description}</p>}
                  <CaptureLink screen={item.screen}>
                    View the desktop screen
                  </CaptureLink>
                </div>
              </details>
            );
          })}
        </div>
        {stop.mode !== "notes" && (
          <div
            className="selection-result"
            aria-live="polite"
            aria-atomic="true"
          >
            {stop.features.map((item, i) => (
              <div
                key={item.name}
                className="feature-result"
                aria-hidden={i !== selected}
              >
                {item.command && <code>{item.command}</code>}
                <p>{item.description}</p>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="stop-world">
        <ProofScreen stop={stop} selected={selected} choose={setSelected} />
        <Station index={index} stop={stop} selected={selected} />
      </div>
    </section>
  );
}

export function Journey() {
  return (
    <div className="journey">
      <div className="journey-guide site-width">
        <div>
          <span className="ticket-key">T-12</span>
          <p>
            Follow one ticket through the workspace.
            <br />
            <span>In the app, its full reference is T-LG12.</span>
          </p>
        </div>
        <nav aria-label="Journey stops">
          {stops.map((s, i) => (
            <a key={s.name} href={"#" + ids[i]}>
              <span>{String(i + 1).padStart(2, "0")}</span> {s.name}
            </a>
          ))}
        </nav>
      </div>
      {stops.map((stop, i) => (
        <JourneyStop key={stop.name} stop={stop} index={i} />
      ))}
    </div>
  );
}
