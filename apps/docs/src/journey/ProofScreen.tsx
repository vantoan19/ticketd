import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useHydrated } from "../components/useHydrated";
import { captures, regionOf } from "./captures";
import { frameFor, markerIn, type Frame } from "./framing";
import type { Feature, Stop } from "./stops";
import { ProofPhoto } from "./ProductImage";
import { ScreenZoom } from "./ScreenZoom";

function Marker({
  item,
  number,
  wide,
  phone,
  selected,
  choose,
}: {
  item: Feature;
  number: number;
  wide: Frame;
  phone: Frame;
  selected: boolean;
  choose: () => void;
}) {
  const desk = markerIn(regionOf(item), wide),
    narrow = markerIn(regionOf(item, true), phone);
  const style = {
    "--wide-pin": desk.visible ? "block" : "none",
    "--small-pin": narrow.visible ? "block" : "none",
    "--wide-x": 100 * desk.x + "%",
    "--wide-y": 100 * desk.y + "%",
    "--small-x": 100 * narrow.x + "%",
    "--small-y": 100 * narrow.y + "%",
    "--wide-offset-x": desk.offsetX,
    "--wide-offset-y": desk.offsetY,
    "--small-offset-x": narrow.offsetX,
    "--small-offset-y": narrow.offsetY,
  } as CSSProperties;
  return (
    <span className="proof-marker" style={style}>
      <button
        type="button"
        className="proof-pin"
        aria-label={number + ". " + item.name}
        aria-pressed={selected}
        onClick={choose}
      >
        {number}
      </button>
    </span>
  );
}
export function ProofScreen({
  stop,
  selected,
  choose,
}: {
  stop: Stop;
  selected: number;
  choose: (n: number) => void;
}) {
  const hydrated = useHydrated();
  // Keep the previous capture, its title and its pins together until the
  // incoming responsive image loads. A second click supersedes the first.
  const [shown, setShown] = useState(selected);
  const [failure, setFailure] = useState<"failed" | "retrying">();
  const [retry, setRetry] = useState({ index: -1, attempt: 0 });
  const retryButton = useRef<HTMLButtonElement>(null);
  const currentSelection = useRef(selected);
  useLayoutEffect(() => {
    currentSelection.current = selected;
  }, [selected]);
  const pending = shown !== selected;
  const busy = pending || failure === "retrying";
  const feature = stop.features[shown]!,
    { screen } = feature,
    info = captures[screen];
  const wide = frameFor(feature, false),
    phone = frameFor(feature, true);
  const style = {
    "--scene-aspect": wide.aspect,
    "--phone-aspect": phone.aspect,
  } as CSSProperties;
  return (
    <div className="proof-wrap">
      <div className="proof-screen" aria-busy={busy || undefined}>
        <div className="proof-bar">
          <span>
            ticketd <i aria-hidden="true">/</i> {info.title}
            {busy && <small className="proof-loading">Loading…</small>}
          </span>
          <ScreenZoom focus={feature} />
        </div>
        <div className="proof-window" style={style}>
          {(pending ? [shown, selected] : [shown]).map((index) => {
            const item = stop.features[index]!;
            const settle = (failed: boolean) => {
              if (index === currentSelection.current) {
                const button = retryButton.current;
                if (!failed && button && button === document.activeElement) {
                  button
                    .closest(".proof-screen")
                    ?.querySelector<HTMLAnchorElement>(".proof-bar a")
                    ?.focus({ preventScroll: true });
                }
                setFailure(failed ? "failed" : undefined);
                setShown(index);
              }
            };
            return (
              <ProofPhoto
                key={index}
                screen={item.screen}
                wide={frameFor(item, false)}
                phone={frameFor(item, true)}
                alt={captures[item.screen].title + ". " + item.description}
                pending={index !== shown}
                attempt={index === retry.index ? retry.attempt : 0}
                onLoad={() => settle(false)}
                onError={() => settle(true)}
              />
            );
          })}
          {failure && (
            <div className="proof-unavailable">
              <span role="status">The preview couldn’t load.</span>
              <button
                type="button"
                ref={retryButton}
                aria-disabled={busy || undefined}
                onClick={() => {
                  if (busy) return;
                  setFailure("retrying");
                  setRetry({ index: shown, attempt: retry.attempt + 1 });
                }}
              >
                {busy ? "Loading preview…" : "Reload preview"}
              </button>
            </div>
          )}
          <div className="proof-content" hidden={!!failure} inert={!hydrated}>
            {stop.features.map(
              (item, i) =>
                item.screen === screen && (
                  <Marker
                    key={item.name}
                    item={item}
                    number={i + 1}
                    wide={wide}
                    phone={phone}
                    selected={shown === i}
                    choose={() => choose(i)}
                  />
                ),
            )}
          </div>
        </div>
      </div>
      <div aria-hidden="true" className="proof-feet">
        <i />
        <i />
      </div>
    </div>
  );
}
