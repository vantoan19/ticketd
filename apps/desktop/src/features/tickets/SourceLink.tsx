import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { cn } from "cn";
import { workspaceClient } from "@/lib/api/workspace";
import { useStatusLine } from "@/components/ui/use-status-line";
import { useCopy } from "@/components/ui/use-copy";
import { describeFailure } from "@/lib/api/describe-failure";
import { Tooltip } from "@/components/ui/tooltip";

/**
 * A link to the issue at its source, opened in the default browser. A webview
 * cannot follow it itself. A failure to open goes to the pane's status line
 * with Copy link, so nothing is inserted beside the link.
 */
export function SourceLink({
  url,
  children,
  className,
  title,
  label,
  icon = true,
}: {
  url: string;
  children: ReactNode;
  className?: string;
  title?: string;
  label?: string;
  icon?: boolean;
}) {
  const statusLine = useStatusLine();
  const { copy } = useCopy();
  if (!url.startsWith("https://")) return <span>{children}</span>;
  return (
    // A real link (its address shows on hover and focus); the app opens it
    // in the default browser because a webview cannot follow it itself.
    <Tooltip content={title}>
      <a
        href={url}
        className={cn("source-link", className)}
        aria-label={label}
        onClick={(event) => {
          event.preventDefault();
          void workspaceClient.openLink(url).catch((reason: unknown) => {
            const failure = describeFailure(reason, "open the link");
            statusLine.show({
              tone: "error",
              message: `${failure.title}. ${failure.sentence}`,
              details: failure.details,
              action: { label: "Copy link", run: () => copy("Link", url) },
            });
          });
        }}
      >
        {children}
        {icon && (
          <ExternalLink className="source-link-icon" aria-hidden="true" />
        )}
      </a>
    </Tooltip>
  );
}
