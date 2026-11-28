import { Card, CardHeader } from "@/components/ui/card";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import { sourceState } from "./ticket-source";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { MarkdownDocument } from "@/features/markdown/MarkdownDocument";
import type { Ticket, TicketSource } from "@/lib/api/client";
import { SourceLink } from "./SourceLink";
import { SourceRail } from "./SourceRail";

function Explanation({
  source,
  field,
  children,
}: {
  source: TicketSource;
  field: string;
  children?: ReactNode;
}) {
  return (
    <PopoverContent align="start" className="source-readonly-explanation">
      <p>
        {source.provider_name} owns this {field}.
      </p>
      <p className="source-caption">
        Edit it on {source.provider_name}; the change arrives on the next
        refresh.
      </p>
      {children ?? (
        <SourceLink url={source.url}>Edit on {source.provider_name}</SourceLink>
      )}
    </PopoverContent>
  );
}

export function ReadOnlyTitle({
  title,
  source,
}: {
  title: string;
  source: TicketSource;
}) {
  return (
    <h1 className="detail-title">
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className="source-title-trigger">
            {title}
          </button>
        </PopoverTrigger>
        <Explanation source={source} field="title" />
      </Popover>
    </h1>
  );
}

export function SourceDescription({
  ticket,
  source,
  select,
  revision,
  refresh,
}: {
  ticket: Ticket;
  source: TicketSource;
  select: (reference: string | null) => void;
  revision: number;
  refresh?: () => Promise<void>;
}) {
  const bodyId = useId();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [long, setLong] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = content.current;
    if (!node) return;
    const measure = () => setLong(node.scrollHeight > 260);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ticket.body]);
  const label = source.unavailable ? "Open" : "Edit";
  const state = sourceState(source);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Card asChild>
        <section
          className="source-description"
          aria-label={`Description from ${source.provider_name}, read-only`}
        >
          <CardHeader>
            <span className="source-card-summary">
              <span>{source.provider_name} issue</span>
              <span aria-hidden="true">·</span>
              <span className="ticket-source-state">
                {state.tone && <StatusDot tone={state.tone} />}
                {state.text}
              </span>
              {(source.created_at || source.author) && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    opened
                    {source.created_at && (
                      <>
                        {" "}
                        <time dateTime={source.created_at}>
                          {new Date(source.created_at).toLocaleDateString(
                            undefined,
                            { dateStyle: "medium" },
                          )}
                        </time>
                      </>
                    )}
                    {source.author && ` by ${source.author}`}
                  </span>
                </>
              )}
            </span>
            <span className="source-card-actions">
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="compact"
                  aria-label="Explain read-only description"
                >
                  <LockKeyhole data-icon="inline-start" />
                  Read-only
                </Button>
              </PopoverTrigger>
              <SourceLink url={source.url}>
                {label} on {source.provider_name}
              </SourceLink>
            </span>
          </CardHeader>
          <div
            id={bodyId}
            className="source-description-clip"
            data-collapsed={(long && !expanded) || undefined}
            onClick={(event) => {
              if (
                !(event.target instanceof Element) ||
                event.target.closest("a, button, input")
              )
                return;
              setOpen(true);
            }}
          >
            <div
              ref={content}
              className="markdown-preview description-document"
            >
              <MarkdownDocument
                source={ticket.body}
                select={select}
                revision={revision}
              />
            </div>
          </div>
          {long && (
            <Button
              variant="link"
              size="sm"
              aria-expanded={expanded}
              aria-controls={bodyId}
              className="source-description-toggle"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "Show less" : "Show full description"}
            </Button>
          )}
        </section>
      </Card>
      <Explanation source={source} field="description">
        {refresh && open && (
          <SourceRail ticket={ticket} refresh={refresh} embedded />
        )}
      </Explanation>
    </Popover>
  );
}
