import { useEffect, useState } from "react";
import FactoryHero from "./FactoryHero";
import {
  WorkExample,
  AgentUpdateExample,
  AssistantExample,
} from "./ProductExamples";
import markup from "./Landing.markup.json";
import { links } from "./links";

function useMediaPreference(query: string) {
  const [matches, setMatches] = useState(
    () => window.matchMedia?.(query).matches ?? false,
  );
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const onChange = () => setMatches(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

export default function Landing() {
  const systemDark = useMediaPreference("(prefers-color-scheme: dark)");
  const reducedMotion = useMediaPreference("(prefers-reduced-motion: reduce)");
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);
  const dark = theme ? theme === "dark" : systemDark;
  return (
    <div
      className="st"
      id="top"
      data-theme={dark ? "dark" : "light"}
      data-motion={reducedMotion ? "reduce" : "normal"}
    >
      <svg
        width="0"
        height="0"
        className="x-defs"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: markup.defs }}
      />
      <header className="st-nav">
        <div className="pd-nav-inner">
          <a className="pd-brand" href="#top">
            ticketd
          </a>
          <nav aria-label="Main navigation">
            <a href="#product">Product</a>
            <a href={links.install}>Docs</a>
            <a href={links.repository}>GitHub ↗</a>
          </nav>
          <button
            type="button"
            className="pd-theme"
            aria-label={dark ? "Use light theme" : "Use dark theme"}
            onClick={() => setTheme(dark ? "light" : "dark")}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              {dark ? (
                <>
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
                </>
              ) : (
                <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
              )}
            </svg>
          </button>
        </div>
      </header>
      <main className="pd-page">
        <FactoryHero reducedMotion={reducedMotion} />
        <section
          className="pd-feature"
          id="product"
          aria-labelledby="pd-work-title"
        >
          <div className="pd-copy">
            <p className="pd-label">TICKETS + CONTEXT</p>
            <h2 id="pd-work-title">
              Keep the work <br />
              and its context <span>together.</span>
            </h2>
            <p>
              Specs, plans, decisions and evidence live alongside your tickets.
              Share a document across work and give every agent the same
              starting point.
            </p>
            <p className="pd-copy-detail">
              A clear workspace for you. Structured context for your agents.
            </p>
          </div>
          <WorkExample />
        </section>
        <section
          className="pd-feature"
          id="activity"
          aria-labelledby="pd-activity-title"
        >
          <div className="pd-copy">
            <p className="pd-label">AGENT VISIBILITY</p>
            <h2 id="pd-activity-title">
              Know what your <br />
              <span>agents are doing.</span>
            </h2>
            <p>
              Follow their updates on the ticket. See what changed, inspect the
              evidence, and spot the work that needs your decision.
            </p>
            <p className="pd-copy-detail">
              Progress you can follow. Decisions you stay in control of.
            </p>
          </div>
          <AgentUpdateExample />
        </section>
        <section
          className="pd-feature"
          id="assistant"
          aria-labelledby="pd-assistant-title"
        >
          <div className="pd-copy">
            <p className="pd-label">AI, BUILT IN</p>
            <h2 id="pd-assistant-title">
              An assistant that <br />
              <span>knows the work.</span>
            </h2>
            <p>
              Ask questions, brainstorm with context, and turn an answer into
              the next ticket. Automations keep routine follow-ups moving.
            </p>
            <p className="pd-copy-detail">
              Grounded in your tickets, documents and agent updates.
            </p>
          </div>
          <AssistantExample />
        </section>
        <section
          className="pd-connections"
          aria-labelledby="pd-connections-title"
        >
          <h2 id="pd-connections-title">
            Your tools. <span>One shared workspace.</span>
          </h2>
          <div className="pd-connection-grid">
            <div>
              <svg viewBox="0 0 40 32" aria-hidden="true">
                <path d="M4 5h32v22H4zM10 12l5 4-5 4m10 0h8" />
              </svg>
              <h3>Alongside your agents</h3>
              <p>
                Work with Orca, T3 Code, your editor or terminal. Agents
                contribute through the CLI.
              </p>
            </div>
            <div>
              <svg viewBox="0 0 40 32" aria-hidden="true">
                <path d="M4 5h10v8H4zm22 0h10v8H26zM15 22h10v8H15zM9 13v5h22v-5m-11 5v4" />
              </svg>
              <h3>Connected to your tools</h3>
              <p>
                Bring tickets from trackers, evidence from Git and documents
                from storage into the same place.
              </p>
            </div>
            <div>
              <svg viewBox="0 0 40 32" aria-hidden="true">
                <path d="M3 5h13v20H3zm21 2h13v20H24zM10 1h22l-3 3m3-3-3-1M30 31H8l3-3m-3 3 3 1" />
              </svg>
              <h3>Local first. Ready to sync.</h3>
              <p>
                Keep your tickets and context on your computer. Sync them across
                workspaces when you need to.
              </p>
            </div>
          </div>
        </section>
        <section className="pd-faq" aria-labelledby="pd-faq-title">
          <h2 id="pd-faq-title">A few practical details.</h2>
          <div>
            <details>
              <summary>Can I keep my existing agent tools?</summary>
              <p>
                Yes. Keep using Orca, T3 Code, your editor or terminal. Ticketd
                connects their work to shared tickets and context, and gives you
                a clear view of their contributions.
              </p>
            </details>
            <details>
              <summary>How do my agents connect?</summary>
              <p>
                Agents that can run shell commands can use the ticketd CLI to
                read context, create tickets and report progress. You can follow
                and guide the same work in the desktop app.
              </p>
            </details>
            <details>
              <summary>What do I install?</summary>
              <p>
                The ticketd desktop app and CLI. The{" "}
                <a href={links.install}>install guide</a> covers macOS, Windows
                and Linux, including making the CLI available to your agents.
              </p>
            </details>
          </div>
        </section>
        <section className="pd-start" aria-labelledby="pd-start-title">
          <h2 id="pd-start-title">
            Make AI work
            <br />
            <span>easier to follow.</span>
          </h2>
          <a className="st-btn st-btn-primary" href={links.install}>
            Get started →
          </a>
        </section>
      </main>
      <footer className="pd-footer">
        <a href="#top" className="pd-brand">
          ticketd
        </a>
        <p>Tickets and context, built for working with AI.</p>
        <a href={links.repository}>GitHub ↗</a>
      </footer>
    </div>
  );
}
