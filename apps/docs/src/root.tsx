import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLocation,
  useMatches,
  useNavigationType,
} from "react-router";
import { ThemeProvider } from "next-themes";
import { useEffect, useRef, type ReactNode } from "react";
import type { Route } from "./+types/root";
import { SiteFooter, SiteHeader } from "./components/SiteChrome";
import { useHydrated } from "./components/useHydrated";
import NotFound from "./routes/not-found";
import { siteUrl } from "./links";
import "./app.css";
import favicon from "../../desktop/src-tauri/icons/32x32.png";
import regular from "../../desktop/src/assets/fonts/Geist-Regular.woff2";
import medium from "../../desktop/src/assets/fonts/Geist-Medium.woff2";

export const links: Route.LinksFunction = () => [
  { rel: "icon", type: "image/png", href: favicon },
  ...[regular, medium].map((href) => ({
    rel: "preload",
    as: "font",
    type: "font/woff2",
    crossOrigin: "anonymous" as const,
    href,
  })),
];

export function Layout({ children }: { children: ReactNode }) {
  const interactive = useHydrated();
  // Pages serves the same 404 document at any missing URL. That URL may match
  // a different client route (such as docs/*) with no prerendered loader data.
  const staticNotFound = useMatches().at(-1)?.id === "routes/not-found";
  return (
    <html
      lang="en"
      data-interactive={interactive || undefined}
      suppressHydrationWarning
    >
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <SiteHeader />
          {children}
          <SiteFooter />
        </ThemeProvider>
        {!staticNotFound && (
          <>
            <ScrollRestoration />
            <Scripts />
          </>
        )}
      </body>
    </html>
  );
}
export default function App() {
  const { key, hash } = useLocation();
  const navigation = useNavigationType();
  const previous = useRef(key);
  useEffect(() => {
    if (previous.current === key) return;
    previous.current = key;
    // Preserve the browser's reading position on Back and Forward.
    if (navigation === "POP") return;
    let id = hash.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      // A literal percent sign is also a valid part of an element ID.
    }
    const target =
      document.getElementById(id || "main-content") ??
      document.getElementById("main-content");
    if (target) {
      if (target.tabIndex < 0) target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
  }, [key, hash, navigation]);
  return <Outlet />;
}
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFound />;
  return (
    <main id="main-content" className="site-width simple-page" tabIndex={-1}>
      <h1>We couldn’t open this page.</h1>
      <a href={siteUrl("/")}>Return to ticketd</a>
    </main>
  );
}
