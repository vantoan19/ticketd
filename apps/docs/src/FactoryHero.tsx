import { useEffect, useRef, useState } from "react";
import plates from "./FactoryPlates.markup.json";
import { links } from "./links";

const moments = [
  {
    id: "idea",
    label: "An important idea",
    status: "Draft",
    title: "An idea becomes work you and your agents can follow.",
    detail:
      "Give the factory an idea. See it become shared context and organized work.",
    quip: "Make login safer. The dog knows my password.",
  },
  {
    id: "organized",
    label: "Work takes shape",
    status: "Todo",
    title: "One idea. A spec, a plan, and three linked tickets.",
    detail:
      "The requirements stay attached, so you and your agent start with the same story.",
    quip: "Context secured. Cat hair included.",
  },
  {
    id: "working",
    label: "Agent at work",
    status: "In progress",
    title: "Your agent has the work and the context behind it.",
    detail:
      "Progress returns to T-12, alongside the decisions and evidence that explain it.",
    quip: "Excellent. I shall supervise from here.",
  },
  {
    id: "reported",
    label: "Report comes back",
    status: "In review",
    title: "Checks passed. Evidence attached. Your turn.",
    detail:
      "T-12 is ready for review, with the agent’s summary and PR #87 in one place.",
    quip: "Awaiting supurrvision.",
  },
  {
    id: "reviewed",
    label: "Pawproved",
    status: "Done",
    title: "You reviewed the work. The cat took the credit.",
    detail:
      "The decision joins the ticket’s history. Everyone can see what happened and why.",
    quip: "Another success for senior management.",
  },
] as const;

function Ink({ part }: { part: string }) {
  return <g dangerouslySetInnerHTML={{ __html: part }} />;
}

function centerFactory(viewport: HTMLDivElement | null) {
  if (viewport)
    viewport.scrollLeft = (viewport.scrollWidth - viewport.clientWidth) / 2;
}

export default function FactoryHero({
  reducedMotion = false,
}: {
  reducedMotion?: boolean;
}) {
  const [step, setStep] = useState(0);
  const [running, setRunning] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const moment = moments[step] ?? moments[0];
  const received = step >= 3;
  const reviewed = step === 4;
  useEffect(() => {
    const viewport = viewportRef.current;
    centerFactory(viewport);
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => centerFactory(viewport));
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!running) return;
    const timer = window.setTimeout(
      () => {
        const next = reducedMotion ? 3 : step + 1;
        setStep(next);
        if (next === 3) setRunning(false);
      },
      reducedMotion ? 0 : 2000,
    );
    return () => window.clearTimeout(timer);
  }, [running, step, reducedMotion]);
  const reset = () => {
    setStep(0);
    setRunning(false);
    setSourceOpen(false);
  };
  const play = () => {
    setSourceOpen(false);
    if (step === 3) return setStep(4);
    if (running) return setRunning(false);
    if (reducedMotion) setStep(3);
    else if (step === 0 || reviewed) setStep(1);
    setRunning(!reducedMotion);
  };

  return (
    <section className="hf-hero" aria-labelledby="st-title" data-sheet="top">
      <div className="hf-heading">
        <div>
          <p className="st-plate" data-on="true">
            <i aria-hidden="true" />
            <span>LOCAL FIRST · AI NATIVE</span>
          </p>
          <h1 id="st-title">
            Tickets and context.
            <br />
            <span className="st-accent">Made for working with AI.</span>
          </h1>
        </div>
        <div className="hf-intro">
          <p>
            Organize the work. Give agents the context. Understand every update,
            in one shared workspace.
          </p>
          <div className="st-hero-ctas">
            <a className="st-btn st-btn-primary" href={links.install}>
              Get started
            </a>
            <a className="st-link" href="#product">
              Meet ticketd ↓
            </a>
          </div>
        </div>
      </div>

      <figure
        className="hf-factory"
        aria-label="You and your AI agents share work through the Ticketd factory"
      >
        <div className="hf-viewport" ref={viewportRef}>
          <div className="hf-stage" data-step={moment.id}>
            <svg
              className="x-art hf-machinery"
              viewBox="0 0 1440 490"
              aria-hidden="true"
            >
              <defs>
                <marker
                  id="hf-arrow"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path fill="context-stroke" d="M1 1L9 5L1 9Z" />
                </marker>
              </defs>
              <Ink part={plates.hero.body} />
              <g
                className="hf-flow-labels x-t2"
                fontSize="12"
                textAnchor="middle"
              >
                <text x="145" y="27">
                  YOU
                </text>
                <text x="720" y="27">
                  YOUR SHARED WORKSPACE
                </text>
                <text x="1309" y="27">
                  YOUR AI AGENTS
                </text>
                <text x="283" y="185" fontSize="11">
                  Ideas &
                  <tspan x="283" dy="17">
                    context
                  </tspan>
                </text>
                <text x="289" y="319" fontSize="11">
                  Progress &
                  <tspan x="289" dy="17">
                    review
                  </tspan>
                </text>
                <text x="1190" y="113" fontSize="10.5">
                  Specs · Plans
                  <tspan x="1190" dy="17">
                    Tickets · Context
                  </tspan>
                </text>
                <text x="1177" y="278" fontSize="11">
                  Updates &
                  <tspan x="1177" dy="17">
                    evidence
                  </tspan>
                </text>
              </g>
              <g
                key={moment.id}
                className="hf-signals"
                fill="none"
                strokeWidth="2"
                markerEnd="url(#hf-arrow)"
              >
                <path
                  className="x-sa hf-flow hf-to-factory"
                  d="M239 260H284V214H334"
                />
                <path
                  className="x-sa hf-flow hf-to-person"
                  d="M334 352H284V397H239"
                />
                <path
                  className="x-sa hf-flow hf-to-agent"
                  d="M1104 214H1160V163H1242"
                />
                <path
                  className="x-sa hf-flow hf-from-agent"
                  d="M1238 330H1181V369H1105"
                />
              </g>
              <g key={`wheel-${moment.id}`} className="hf-wheel">
                <Ink part={plates.hero.wheel} />
              </g>
              <g
                key={`cat-${moment.id}`}
                className={`hf-cat-art${step >= 2 ? " hf-cat-alert" : ""}`}
              >
                <Ink part={plates.hero.cat} />
              </g>
              {step >= 2 && (
                <g transform="rotate(-8 187 277)">
                  <rect
                    className="x-p x-i"
                    x="173"
                    y="250"
                    width="25"
                    height="33"
                  />
                  <rect className="x-k" x="179" y="246" width="13" height="7" />
                  <path className="x-i x-n" d="M178 261h15m-15 6h15m-15 6h9" />
                </g>
              )}
              <Ink part={plates.hero.desk} />
              {step > 0 && (
                <g
                  key={`paper-${moment.id}`}
                  className={`hf-transfer hf-transfer-${moment.id}`}
                >
                  <path className="x-p x-i" d="M0 0h14l6 6v21H0Z" />
                  <path className="x-sa" d="M4 12h12m-12 5h10m-10 5h8" />
                </g>
              )}
              {reviewed && (
                <g transform="translate(111 265)">
                  <g className="hf-stamp">
                    <rect
                      className="x-p x-i"
                      x="0"
                      y="19"
                      width="35"
                      height="8"
                    />
                    <path className="x-i" d="M17 19V8" strokeWidth="5" />
                    <rect
                      className="x-a x-i"
                      x="5"
                      y="2"
                      width="25"
                      height="7"
                    />
                  </g>
                </g>
              )}
            </svg>

            <div className="hf-request" data-fed={step > 0}>
              <span>{step === 0 ? "THE IDEA" : "THE FOREMAN"}</span>
              <p>{moment.quip}</p>
              {reviewed && <span className="hf-paw-seal">PAWPROVED</span>}
              <i aria-hidden="true" />
            </div>

            <div
              className="hf-screen"
              role="region"
              aria-label="Ticketd example workspace"
            >
              <div className="hf-screen-bar">
                <b>ticketd</b>
                <span>web-app / Login hardening</span>
                <span className="hf-local">● Local</span>
              </div>
              <div className="hf-screen-body">
                <aside
                  className="hf-sidebar"
                  aria-label="Connected context and work"
                >
                  <span className="hf-ui-label">CONTEXT</span>
                  <button
                    type="button"
                    className="hf-source-link"
                    aria-expanded={sourceOpen}
                    onClick={() => {
                      setRunning(false);
                      setSourceOpen((open) => !open);
                    }}
                  >
                    ▤ Login hardening spec <span>↗</span>
                  </button>
                  <span className="hf-ui-label hf-plan-label">
                    PLAN · LOGIN HARDENING
                  </span>
                  <div className="hf-mini-ticket hf-selected">
                    <span>T-12</span>
                    <b>Rate-limit logins</b>
                    <small>{moment.status}</small>
                  </div>
                  <div className="hf-mini-ticket">
                    <span>T-13</span>
                    <b>Alert on-call</b>
                    <small>
                      {reviewed ? "Ready" : step ? "Blocked by T-12" : "Draft"}
                    </small>
                  </div>
                  <div className="hf-mini-ticket">
                    <span>T-14</span>
                    <b>Show wait time</b>
                    <small>{step ? "Todo" : "Draft"}</small>
                  </div>
                </aside>
                {sourceOpen ? (
                  <article
                    className="hf-ticket hf-spec"
                    aria-label="Login hardening specification"
                  >
                    <div className="hf-ticket-meta">
                      <span>DOCUMENT / SPEC</span>
                      <button
                        type="button"
                        onClick={() => setSourceOpen(false)}
                      >
                        Back to T-12 ↩
                      </button>
                    </div>
                    <h2>Login hardening spec</h2>
                    <p>
                      Protect accounts from repeated login attempts without
                      permanently locking out their owners.
                    </p>
                    <ul>
                      <li>Limit by account and IP address.</li>
                      <li>Allow 5 failed attempts per 15 minutes.</li>
                      <li>Return 429 with a Retry-After header.</li>
                    </ul>
                    <div className="hf-source-foot">
                      One source · linked to T-12 and T-13
                    </div>
                  </article>
                ) : (
                  <article
                    className="hf-ticket"
                    aria-label="T-12: Rate-limit failed login attempts"
                  >
                    <div className="hf-ticket-meta">
                      <span>T-12 / LOCAL TICKET</span>
                      <span className="hf-ticket-status">{moment.status}</span>
                    </div>
                    <h2>Rate-limit failed login attempts</h2>
                    <p>
                      Limit repeated login attempts per account and IP. Keep the
                      requirements, progress, and proof together.
                    </p>
                    <div className="hf-ticket-links">
                      <span>↗ Login hardening spec</span>
                      <span>◫ Login hardening Plan</span>
                    </div>
                    <div
                      className="hf-activity"
                      data-attention={received && !reviewed}
                    >
                      <span className="hf-ui-label">
                        {reviewed
                          ? "YOU · REVIEW RECORDED"
                          : step >= 2
                            ? "CODING-AGENT · LATEST UPDATE"
                            : "YOU + AI · PLANNING"}
                      </span>
                      <p>
                        {reviewed
                          ? "Reviewed the change and approved T-12."
                          : received
                            ? "Rate limiter implemented. Checks passed. Ready for your review."
                            : step === 2
                              ? "Implementing account and IP limits. The spec and Plan are attached."
                              : step === 1
                                ? "Spec saved. Three tickets linked to the Plan. Ready for your agent."
                                : "One spec, one plan, three tickets. The context stays connected to every step."}
                      </p>
                    </div>
                    <div className="hf-evidence">
                      {received ? (
                        <>
                          <span>↗ PR #87</span>
                          <span>✓ Checks passed</span>
                        </>
                      ) : (
                        <>
                          <span>▤ Shared context</span>
                          <span>
                            {step ? "3 linked tickets" : "Draft preview"}
                          </span>
                        </>
                      )}
                    </div>
                  </article>
                )}
              </div>
            </div>

            <span className="hf-agent-note">
              Your editor, terminal & agent apps
            </span>
          </div>
        </div>
        <p className="hf-pan-hint">← Pan to explore the whole factory →</p>
      </figure>

      <div className="hf-controls">
        <div className="hf-moment" aria-live="polite" aria-atomic="true">
          <div>
            <strong>{moment.title}</strong>
            <p>{moment.detail}</p>
          </div>
        </div>
        <div className="hf-actions">
          <button
            type="button"
            className="hf-reset"
            aria-label="Reset the factory example"
            disabled={step === 0 && !sourceOpen}
            onClick={reset}
          >
            Reset
          </button>
          <button
            type="button"
            className="st-btn st-btn-primary hf-next"
            onClick={play}
          >
            {step === 3
              ? "Approve the example"
              : reviewed
                ? "Run it again"
                : running
                  ? "Pause demo"
                  : step > 0
                    ? "Continue demo"
                    : "See it work"}
            <span aria-hidden="true">→</span>
          </button>
        </div>
      </div>
    </section>
  );
}
