import { useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { cn } from "cn";
import { workspaceClient } from "@/lib/api/workspace";
import { Tooltip } from "@/components/ui/tooltip";

/**
 * A link to the issue at its source, opened in the default browser. A webview
 * cannot follow it itself, and a failure to open is said beside the link.
 */
export function SourceLink({
  url,
  children,
  className,
  title,
  icon = true,
}: {
  url: string;
  children: ReactNode;
  className?: string;
  title?: string;
  icon?: boolean;
}) {
  const [error, setError] = useState("");
  if (!url.startsWith("https://")) return <span>{children}</span>;
  return (
    <>
      {/* A real link (its address shows on hover and focus); the app opens it
          in the default browser because a webview cannot follow it itself. */}
      <Tooltip content={title}>
      <a
        href={url}
        className={cn("source-link", className)}
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
        {icon && (
          <ExternalLink className="source-link-icon" aria-hidden="true" />
        )}
      </a>
      </Tooltip>
      {error && <small role="alert">{error}</small>}
    </>
  );
}
