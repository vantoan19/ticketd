import { Card, CardHeader } from "@/components/ui/card";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { MarkdownDocument } from "@/features/markdown/MarkdownDocument";
import type { Ticket, TicketSource } from "@/lib/api/client";
import { SourceLink } from "./SourceLink";

function Explanation({
  source,
  field,
}: {
  source: TicketSource;
  field: string;
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
      <SourceLink url={source.url}>Edit on {source.provider_name}</SourceLink>
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
    <h3 className="detail-title">
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className="source-title-trigger">
            {title}
          </button>
        </PopoverTrigger>
        <Explanation source={source} field="title" />
      </Popover>
    </h3>
  );
}

export function SourceDescription({
  ticket,
  source,
  select,
  revision,
}: {
  ticket: Ticket;
  source: TicketSource;
  select: (reference: string | null) => void;
  revision: number;
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
  const label = source.unavailable
    ? "Open"
    : source.status_locked
      ? "View"
      : "Edit";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Card asChild>
        <section
          className="source-description"
          aria-label={`Description from ${source.provider_name}, read-only`}
        >
          <CardHeader>
            <span>{source.provider_name} issue</span>
            <span className="source-card-actions">
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
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
      <Explanation source={source} field="description" />
    </Popover>
  );
}
