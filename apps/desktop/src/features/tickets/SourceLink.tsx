import { useState, type ReactNode } from "react";
import { workspaceClient } from "@/lib/api/workspace";

/**
 * A link to the issue at its source, opened in the default browser. A webview
 * cannot follow it itself, and a failure to open is said beside the link.
 */
export function SourceLink({
  url,
  children,
  className,
}: {
  url: string;
  children: ReactNode;
  className?: string;
}) {
  const [error, setError] = useState("");
  if (!url.startsWith("https://")) return <span>{children}</span>;
  return (
    <>
      {/* A real link (its address shows on hover and focus); the app opens it
          in the default browser because a webview cannot follow it itself. */}
      <a
        href={url}
        className={`source-link ${className ?? ""}`.trim()}
        onClick={(event) => {
          event.preventDefault();
          void workspaceClient.openLink(url).then(
            () => setError(""),
            (reason: unknown) =>
              setError(`Could not open the link: ${String(reason)}`),
          );
        }}
      >
        {children}
      </a>
      {error && <small role="alert">{error}</small>}
    </>
  );
}
