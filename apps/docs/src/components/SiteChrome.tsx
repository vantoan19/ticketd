import { ArrowUpRight, Moon, Sun } from "lucide-react";
import { NavLink } from "react-router";
import { useTheme } from "next-themes";
import { links, siteUrl } from "../links";
import { useHydrated } from "./useHydrated";

export function Wordmark() {
  return (
    <a className="wordmark" href={siteUrl("/")} aria-label="ticketd home">
      <svg aria-hidden="true" viewBox="66 66 892 892" width="28" height="28">
        <rect
          x="100"
          y="100"
          width="824"
          height="824"
          rx="186"
          fill="currentColor"
        />
        <rect
          x="266"
          y="356"
          width="468"
          height="312"
          rx="156"
          fill="var(--mark-track)"
        />
        <circle cx="578" cy="512" r="156" fill="var(--mark-disc)" />
      </svg>
      ticketd
    </a>
  );
}
const destinations = [
  ["Docs", "/docs"],
  ["Download", "/download"],
  ["Changelog", "/changelog"],
] as const;

function SiteLinks() {
  return (
    <>
      {destinations.map(([name, to]) => (
        <NavLink key={to} to={to}>
          {name}
        </NavLink>
      ))}
      <a href={links.repository}>
        GitHub <ArrowUpRight size={13} aria-hidden="true" />
      </a>
    </>
  );
}

export function SiteHeader() {
  const { resolvedTheme, setTheme } = useTheme();
  const dark = useHydrated() && resolvedTheme === "dark";
  return (
    <header className="site-header">
      <a className="skip-link" href="#main-content" tabIndex={0}>
        Skip to content
      </a>
      <div className="site-width masthead">
        <Wordmark />
        <div className="masthead-end">
          <nav aria-label="Main navigation">
            <SiteLinks />
          </nav>
          <button
            type="button"
            className="theme-switch"
            aria-pressed={dark}
            title={dark ? "Switch to light theme" : "Switch to dark theme"}
            onClick={() =>
              setTheme(resolvedTheme === "dark" ? "light" : "dark")
            }
          >
            <span className="sr-only">Dark theme</span>
            <Sun size={17} className="theme-sun" aria-hidden="true" />
            <Moon size={17} className="theme-moon" aria-hidden="true" />
          </button>
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-width">
        <Wordmark />
        <nav aria-label="Footer">
          <SiteLinks />
          <a href={links.license}>MIT license</a>
        </nav>
      </div>
    </footer>
  );
}

export function CallsToAction({ available = false }: { available?: boolean }) {
  return (
    <div className="action-row">
      <a
        className="action-primary"
        href={available ? siteUrl("/download") : links.repository}
      >
        {available ? "Download ticketd" : "Get it on GitHub"}{" "}
        <ArrowUpRight aria-hidden="true" size={16} />
      </a>
      <a className="action-secondary" href={siteUrl("/docs")}>
        Read the docs <span aria-hidden="true">→</span>
      </a>
    </div>
  );
}
