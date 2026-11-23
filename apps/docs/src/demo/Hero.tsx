import { Pause, Play } from "lucide-react";
import { stationIds } from "../art/world-layout";
import { useEffect, useRef, useReducer, useSyncExternalStore } from "react";
import { CallsToAction } from "../components/SiteChrome";
import { useProgressiveControls } from "../components/useHydrated";
import { DesktopDisplay } from "./DesktopDisplay";
import { World } from "./World";
import { demoReducer, initialDemo } from "./state";
import { stages, type Stage } from "./workspace";

const motionQuery = "(prefers-reduced-motion: reduce)";
function motionSupported() {
  return (
    typeof window.requestAnimationFrame === "function" &&
    typeof window.matchMedia === "function"
  );
}
function subscribeMotion(notify: () => void) {
  if (!motionSupported()) return () => {};
  const media = window.matchMedia(motionQuery);
  media.addEventListener?.("change", notify);
  return () => media.removeEventListener?.("change", notify);
}
function useReducedMotion() {
  return useSyncExternalStore(
    subscribeMotion,
    () => !motionSupported() || window.matchMedia(motionQuery).matches,
    () => true,
  );
}

export function Hero({ available }: { available: boolean }) {
  const { interactive, nativeProps } = useProgressiveControls();
  const [state, dispatch] = useReducer(demoReducer, initialDemo);
  const { stage, playing } = state;
  const monitor = useRef<HTMLDivElement>(null);
  const still = useReducedMotion();
  useEffect(() => {
    const el = monitor.current;
    if (!el || !interactive || still || !playing) return;
    const story = el.closest(".landing-story");
    let timer: number | undefined;
    let inView = true;
    const schedule = () => {
      window.clearInterval(timer);
      if (inView && !document.hidden && !story?.hasAttribute("data-travel"))
        timer = window.setInterval(() => dispatch({ type: "tick" }), 6600);
    };
    const watcher =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(([entry]) => {
            inView = Boolean(entry?.isIntersecting);
            schedule();
          })
        : null;
    watcher?.observe(el);
    document.addEventListener("visibilitychange", schedule);
    story?.addEventListener("ticketd-travel", schedule);
    schedule();
    return () => {
      watcher?.disconnect();
      document.removeEventListener("visibilitychange", schedule);
      story?.removeEventListener("ticketd-travel", schedule);
      window.clearInterval(timer);
    };
  }, [interactive, playing, still]);
  function choose(index: Stage) {
    dispatch({ type: "step", stage: index });
  }
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="site-width hero-lead">
        <h1 id="hero-title">
          A ticket workspace for
          <br />
          you and your AI agents.
        </h1>
        <div className="hero-intro">
          <p>
            Plan a ticket, hand it to Claude Code or Codex, and review what
            changed. A free, open-source desktop app and CLI.
          </p>
          <CallsToAction available={available} />
          <span className="hero-platforms">macOS, Ubuntu and Windows</span>
        </div>
      </div>
      <div className="hero-installation" data-stage={stage}>
        <div
          className="monitor"
          ref={monitor}
          role="region"
          aria-label="Interactive ticket demonstration"
          onPointerDownCapture={(e) => {
            if (!(e.target as Element).closest(".playback"))
              dispatch({ type: "pause" });
          }}
          onFocusCapture={(e) => {
            if (
              e.target.matches(":focus-visible") &&
              !e.target.closest(".playback")
            )
              dispatch({ type: "pause" });
          }}
        >
          <div className="monitor-toolbar">
            <span className="demo-label">
              <i aria-hidden="true" />
              Demonstration
            </span>
            <div
              {...nativeProps}
              className={interactive ? "demo-steps" : "demo-steps static-guide"}
              role={interactive ? "group" : "navigation"}
              aria-label={
                interactive
                  ? "Demonstration steps"
                  : "Read the four demonstration steps"
              }
            >
              {stages.map((s, i) => {
                const label = (
                  <>
                    <span className="step-no" aria-hidden="true">
                      {i + 1}
                    </span>
                    {s.label}
                  </>
                );
                return interactive ? (
                  <button
                    type="button"
                    className="demo-step"
                    key={s.label}
                    aria-pressed={stage === i}
                    onClick={() => choose(i as Stage)}
                  >
                    {label}
                  </button>
                ) : (
                  <a
                    className="demo-step"
                    key={s.label}
                    href={"#" + stationIds[i]}
                    aria-current={i === stage ? "step" : undefined}
                  >
                    {label}
                  </a>
                );
              })}
            </div>
            <button
              type="button"
              className="playback"
              disabled={!interactive || still}
              aria-label={
                still
                  ? "Autoplay off for reduced motion"
                  : playing
                    ? "Pause demonstration"
                    : "Play demonstration"
              }
              title={still ? "Reduced motion" : playing ? "Pause" : "Play"}
              onClick={() => dispatch({ type: "toggle" })}
            >
              {playing && !still ? <Pause size={14} /> : <Play size={14} />}
            </button>
          </div>
          <DesktopDisplay state={state} dispatch={dispatch} />
          <div
            className="monitor-caption"
            aria-live={playing ? "off" : "polite"}
            aria-atomic="true"
          >
            <span className="caption-stage" aria-hidden="true">
              {String(stage + 1).padStart(2, "0")} / 04
            </span>
            <span aria-hidden="true">{stages[stage].caption}</span>
            <span className="sr-only">
              {`Step ${stage + 1} of 4. ${stages[stage].caption}`}
            </span>
          </div>
        </div>
        <World stage={stage} still={still} />
      </div>
    </section>
  );
}
