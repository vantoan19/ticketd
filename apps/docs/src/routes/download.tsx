import { useCallback, useState } from "react";
import { ArrowUpRight, Download as DownloadIcon } from "lucide-react";
import sprite from "virtual:ticketd-art";
import { getReleases, platformDownloads } from "../lib/releases.server";
import { links, siteUrl } from "../links";
import type { Route } from "./+types/download";
import "./distribution.css";

export const meta = () => [
  { title: "Download ticketd" },
  {
    name: "description",
    content:
      "Get ticketd for macOS, Ubuntu or Windows. Set up the desktop and the command line for your AI agents.",
  },
];
export async function loader() {
  return platformDownloads(await getReleases());
}
const systems = [
  {
    id: "macos",
    name: "macOS",
    architecture: "macOS 26 · Apple Silicon",
    prepare: "Install Xcode Command Line Tools and the native Rust toolchain.",
    install: "Open the DMG and drag ticketd into Applications.",
    cli: "In Settings → Command line, choose Install command-line tool. Reopen your terminal. If you decline the password and choose ~/.local/bin instead, add it to PATH.",
  },
  {
    id: "ubuntu",
    name: "Ubuntu",
    architecture: "Ubuntu 24.04 · x86-64",
    prepare:
      "Install WebKitGTK 4.1 and the Linux dependencies in the development guide.",
    install:
      "Install the Debian package with sudo apt install ./ticketd_*.deb. Your package manager installs its desktop dependencies.",
    cli: "The Debian package installs ticketd in /usr/bin. The app and an agent running as the same user share a workspace.",
  },
  {
    id: "windows",
    name: "Windows",
    architecture: "Windows 11 · x86-64",
    prepare:
      "Install the desktop C++ workload, WebView2 and the MSVC Rust toolchain. Use native Windows Node and Rust.",
    install:
      "Run the MSI installer. Check the release notes for the signing status and first-launch instructions.",
    cli: "In Settings → Command line, choose Install command-line tool. Restart your terminals and agent harnesses to pick up the updated user PATH.",
  },
] as const;
export type OS = (typeof systems)[number]["id"];
export function systemFor(agent: string): OS | null {
  if (/Android|iPhone|iPad|iPod/i.test(agent)) return null;
  if (/Windows|Win32/i.test(agent)) return "windows";
  if (/Macintosh|MacIntel|Mac OS/i.test(agent)) return "macos";
  if (/Linux|Ubuntu/i.test(agent)) return "ubuntu";
  return null;
}
function detect() {
  return navigator.maxTouchPoints > 1 && navigator.platform === "MacIntel"
    ? null
    : systemFor(navigator.userAgent);
}
function SystemSteps({ data }: { data: Route.ComponentProps["loaderData"] }) {
  const [os, choose] = useState<OS | null>(null);
  const initialSelection = useCallback(
    (fieldset: HTMLFieldSetElement | null) => {
      if (!fieldset) return;
      // The prerendered radios work before hydration. An actual checked input
      // is the visitor's choice, including when they have already moved focus.
      const input = fieldset.querySelector<HTMLInputElement>("input:checked");
      choose(
        systems.find((system) => system.id === input?.value)?.id ??
          detect() ??
          "macos",
      );
    },
    [],
  );
  return (
    <section
      id="setup"
      className="system-section"
      aria-labelledby="setup-title"
    >
      <h2 id="setup-title">Set up your system</h2>
      <fieldset className="system-picker" ref={initialSelection}>
        <legend className="sr-only">Operating system</legend>
        <noscript>
          <style>{`
            @supports not selector(:has(input)) {
              .system-picker > label { display: none; }
              .system-panels { display: block; }
              .system-picker .system-panel { visibility: visible; pointer-events: auto; }
            }
          `}</style>
        </noscript>
        {systems.map((s) => (
          <label key={s.id}>
            <input
              type="radio"
              name="platform"
              value={s.id}
              aria-label={s.name}
              checked={os === s.id}
              onChange={() => choose(s.id)}
            />
            <span>{s.name}</span>
          </label>
        ))}
        <div className="system-panels">
          {systems.map((s) => {
            const downloads = data.groups[s.id];
            return (
              <section
                key={s.id}
                className={"system-panel panel-" + s.id}
                data-selected={s.id === (os ?? "macos") || undefined}
                aria-label={s.name + " setup"}
              >
                <h3>{s.architecture}</h3>
                {downloads.desktop ? (
                  <a className="action-primary" href={downloads.desktop}>
                    <DownloadIcon size={15} /> Download for {s.name}
                  </a>
                ) : (
                  <p>
                    {s.prepare} Follow the repository’s{" "}
                    <a href={links.development}>development setup</a> to build
                    and run ticketd.
                  </p>
                )}
                <h4>
                  {downloads.desktop
                    ? "Install the desktop app"
                    : "With a packaged build"}
                </h4>
                <p>
                  {s.install}{" "}
                  {downloads.desktop && (
                    <a href={siteUrl("/docs/install#" + s.id)}>
                      Installation guide
                    </a>
                  )}
                </p>
                <h4>Command-line tool</h4>
                <p>{s.cli}</p>
                {downloads.cli && (
                  <a className="text-link" href={downloads.cli}>
                    Download the standalone CLI
                  </a>
                )}
              </section>
            );
          })}
        </div>
      </fieldset>
    </section>
  );
}
export default function DownloadPage({
  loaderData: data,
}: Route.ComponentProps) {
  const hasInstaller = Object.values(data.groups).some((s) => s.desktop);
  return (
    <main className="distribution site-width" id="main-content" tabIndex={-1}>
      <div className="distribution-lead">
        <div>
          <h1 className="page-heading">Get ticketd.</h1>
          <p>
            The desktop app and the command line share one workspace for you and
            your AI agents.
          </p>
          <div className="action-row">
            {hasInstaller ? (
              <a className="action-primary" href="#setup">
                Choose your platform <DownloadIcon size={15} />
              </a>
            ) : (
              <a className="action-primary" href={links.repository}>
                Get it on GitHub <ArrowUpRight size={16} />
              </a>
            )}
            <a className="action-secondary" href={links.development}>
              Build from source <span aria-hidden="true">↗</span>
            </a>
          </div>
          <p className="release-availability">
            {data.release ? (
              <>
                <a href={data.release.url}>{data.release.name}</a>
                {data.release.preview ? " · Published preview" : ""}
              </>
            ) : data.status === "unavailable" ? (
              <>
                Check <a href={links.releases}>GitHub Releases</a> for the
                current installers.
              </>
            ) : (
              "The first public release is still ahead. You can build ticketd from source today."
            )}
          </p>
        </div>
        <svg
          viewBox="-107 -65 272 221"
          aria-label="The ticketd desktop package and its bundled CLI on the same platform."
          role="img"
        >
          <use href={sprite + "#download-model"} />
        </svg>
      </div>
      <div className="distribution-columns">
        <SystemSteps data={data} />
        <aside className="cli-guide">
          <h2>Use it with an AI agent</h2>
          <p>Run these in the terminal your agent uses.</p>
          <pre>
            <code>{"ticketd --version\nticketd workspace"}</code>
          </pre>
          <p>
            The first command identifies the binary. The second prints the
            workspace path without changing it.
          </p>
          <a className="text-link" href={siteUrl("/docs/agents/connect")}>
            Connect Claude Code or Codex →
          </a>
          <div className="guide-note">
            <h3>Updates</h3>
            <p>
              The bundled CLI updates with the desktop. A standalone CLI is
              updated by replacing its executable.
            </p>
            <a className="text-link" href={siteUrl("/docs/install#updates")}>
              Installation and updates →
            </a>
          </div>
        </aside>
      </div>
    </main>
  );
}
