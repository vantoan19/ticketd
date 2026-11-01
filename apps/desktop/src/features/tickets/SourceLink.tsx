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
      <button
        type="button"
        className={`source-link ${className ?? ""}`.trim()}
        onClick={() =>
          void workspaceClient.openLink(url).then(
            () => setError(""),
            (reason: unknown) =>
              setError(`Could not open the link: ${String(reason)}`),
          )
        }
      >
        {children}
      </button>
      {error && <small role="alert">{error}</small>}
    </>
  );
}
