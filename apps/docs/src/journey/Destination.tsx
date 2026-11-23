import { CallsToAction } from "../components/SiteChrome";
import { ScreenZoom } from "./ScreenZoom";
import { World } from "../demo/World";
import { siteUrl } from "../links";

export function Destination({ available }: { available: boolean }) {
  return (
    <section className="destination" aria-labelledby="destination-title">
      <div className="destination-model">
        <div className="destination-panel">
          <div className="destination-status">
            <span aria-hidden="true">✓</span> T-LG12 <b>Done</b>
            <ScreenZoom
              focus={{ screen: "done", region: "completed" }}
              label="View board"
            />
          </div>
          <h2 id="destination-title">A place for your AI agents to work.</h2>
          <p>Keep the Plan, the ticket and the result together.</p>
          <CallsToAction available={available} />
        </div>
        <World stage={3} still closing />
      </div>
    </section>
  );
}

const integrations = [
  [
    "Claude Code",
    "Read and update tickets from the CLI or work in an experimental Chat.",
    "/docs/agents/connect",
  ],
  [
    "Codex",
    "Give a coding agent the same Plan, tickets and Documents.",
    "/docs/agents/connect",
  ],
  [
    "GitHub Issues",
    "Import issues or publish a local ticket as a GitHub issue.",
    "/docs/concepts/context#github-issues",
  ],
  [
    "Google Drive",
    "Sync the workspace between your own computers.",
    "/docs/concepts/context#workspace-sync",
  ],
] as const;
export function Foundations() {
  return (
    <section className="foundations" aria-label="About ticketd">
      <div className="site-width">
        <h2 id="works-title">Works with</h2>
        <dl className="integration-grid" aria-labelledby="works-title">
          {integrations.map(([name, body, to]) => (
            <div key={name}>
              <dt>
                <a href={siteUrl(to)}>
                  {name} <span aria-hidden="true">↗</span>
                </a>
              </dt>
              <dd>{body}</dd>
            </div>
          ))}
        </dl>
        <dl className="site-facts" aria-label="Workspace facts">
          <div>
            <dt>On your computer</dt>
            <dd>A local workspace. No ticketd account.</dd>
          </div>
          <div>
            <dt>Free and open source</dt>
            <dd>Use it, read the code, or change it under the MIT license.</dd>
          </div>
          <div>
            <dt>Desktop and command line</dt>
            <dd>Two ways to work with the same tickets.</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
