import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronRight, ChevronUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { matchesShortcut } from "@/lib/shortcuts";
import { MarkdownDocument } from "@/features/markdown/MarkdownDocument";
import { describeTicketMarkdown } from "./description-folds";
import { findDescription, type DescriptionMatch } from "./description-find";
import {
  TICKET_DESCRIPTION_REVEAL,
  type TicketDescriptionReveal,
} from "./description-navigation";
import { revealInDetail } from "./detail-scroll";
import "./description.css";

type MarkdownProps = ComponentProps<typeof MarkdownDocument>;
type Props = Pick<
  MarkdownProps,
  "source" | "select" | "revision" | "onChange"
> & {
  ticketId: string;
  peek?: boolean;
  mention?:
    (NonNullable<MarkdownProps["mention"]> & { key: number }) | undefined;
};

function foldKey(ticketId: string) {
  return `ticketd.description-folds.${ticketId}`;
}

function readOpenFolds(ticketId: string): string[] {
  try {
    const saved: unknown = JSON.parse(
      localStorage.getItem(foldKey(ticketId)) ?? "[]",
    );
    return Array.isArray(saved)
      ? saved.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

function Fold({
  foldId,
  label,
  open,
  onToggle,
  children,
}: {
  foldId: string;
  label: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="ticket-description-fold">
      <Button
        type="button"
        variant="ghost"
        size="compact"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
      >
        {open ? (
          <ChevronDown aria-hidden="true" />
        ) : (
          <ChevronRight aria-hidden="true" />
        )}
        <span>{label}</span>
      </Button>
      <div
        id={id}
        className="ticket-description-fold-content"
        data-description-fold={foldId}
        hidden={!open}
      >
        {children}
      </div>
    </div>
  );
}

/** Shared reading surface for editable, externally owned, and trashed tickets. */
export function TicketDescription({ ticketId, peek, ...markdown }: Props) {
  return (
    <TicketDescriptionReading
      key={peek ? `${ticketId}:peek` : ticketId}
      ticketId={ticketId}
      peek={peek ?? false}
      {...markdown}
    />
  );
}

type DescriptionSearch = {
  source: string;
  query: string;
  index: number;
  matches: DescriptionMatch[];
  revealed: string[];
};

function descriptionSearch(
  source: string,
  query: string,
  matches: DescriptionMatch[] = [],
  index = 0,
): DescriptionSearch {
  return {
    source,
    query,
    index,
    matches,
    revealed: matches.flatMap(({ fold }) => (fold === undefined ? [] : [fold])),
  };
}

function TicketDescriptionReading({ ticketId, peek, ...markdown }: Props) {
  const { source, mention } = markdown;
  const { acceptance, folds } = useMemo(
    () => describeTicketMarkdown(source, peek),
    [source, peek],
  );
  const [opened, setOpened] = useState(() =>
    peek ? [] : readOpenFolds(ticketId),
  );
  const [search, setSearch] = useState<DescriptionSearch | null>(null);
  const [jump, setJump] = useState<{ offset: number; atTop: boolean } | null>(
    null,
  );
  const [openedForJump, setOpenedForJump] = useState<string>();
  const [collapsedMentionKey, setCollapsedMentionKey] = useState<number>();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const priorFocus = useRef<HTMLElement | null>(null);
  const focusingSearch = search !== null;

  useEffect(() => {
    const node = root.current;
    if (!node) return;
    const inView = () => !node.closest("[hidden], [inert], [data-graph]");
    function find(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        !inView() ||
        !matchesShortcut(event, "ticket-find-description")
      )
        return;
      if (
        event.target instanceof Element &&
        event.target.closest("[role=dialog], [role=menu]")
      )
        return;
      event.preventDefault();
      if (input.current) {
        input.current.select();
        input.current.focus({ preventScroll: true });
        revealInDetail(input.current);
        return;
      }
      priorFocus.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setSearch(descriptionSearch(source, ""));
    }

    function reveal(event: Event) {
      const { detail } = event as CustomEvent<TicketDescriptionReveal>;
      if (detail?.ticketId !== ticketId || !inView()) return;
      const offset =
        detail.target === "acceptance"
          ? acceptance?.start
          : detail.target.headingOffset;
      if (offset === undefined) return;
      setOpenedForJump(
        folds.find(({ start, end }) => start <= offset && offset < end)?.id,
      );
      setJump({ offset, atTop: detail.target !== "acceptance" });
    }

    window.addEventListener("keydown", find);
    window.addEventListener(TICKET_DESCRIPTION_REVEAL, reveal);
    return () => {
      window.removeEventListener("keydown", find);
      window.removeEventListener(TICKET_DESCRIPTION_REVEAL, reveal);
    };
  }, [acceptance, folds, source, ticketId]);

  useLayoutEffect(() => {
    if (!focusingSearch || !input.current) return;
    input.current.focus({ preventScroll: true });
    revealInDetail(input.current);
  }, [focusingSearch]);

  useLayoutEffect(() => {
    if (!jump) return;
    const heading = root.current?.querySelector<HTMLElement>(
      `[data-heading-offset="${jump.offset}"]`,
    );
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
      revealInDetail(heading, undefined, jump.atTop ? 24 : undefined);
    }
  }, [jump]);

  useLayoutEffect(() => {
    if (!search || search.source === source || !root.current) return;
    const matches = findDescription(root.current, search.query);
    setSearch(descriptionSearch(source, search.query, matches));
  }, [search, source]);

  const currentMatch =
    search?.source === source ? search.matches[search.index] : undefined;
  useLayoutEffect(() => {
    if (!currentMatch) return;
    const { block, range } = currentMatch;
    revealInDetail(
      block,
      typeof range.getBoundingClientRect === "function"
        ? range.getBoundingClientRect()
        : undefined,
    );
    const highlights = globalThis.CSS?.highlights;
    if (typeof Highlight === "undefined" || !highlights) return;
    const name = "ticket-description-find";
    let highlight = highlights.get(name);
    if (!highlight) {
      highlight = new Highlight();
      highlights.set(name, highlight);
    }
    highlight.add(range);
    return () => {
      highlight.delete(range);
      if (highlight.size === 0) highlights.delete(name);
    };
  }, [currentMatch]);

  function find(query: string, direction = 0) {
    if (!root.current) return;
    const matches = findDescription(root.current, query);
    const index =
      direction && search && matches.length
        ? (search.index + direction + matches.length) % matches.length
        : 0;
    setSearch(descriptionSearch(source, query, matches, index));
  }

  function closeSearch() {
    setSearch(null);
    const previous = priorFocus.current;
    const focus =
      previous?.isConnected &&
      previous !== document.body &&
      !previous.closest("[hidden], [inert]")
        ? previous
        : root.current;
    focus?.focus({ preventScroll: true });
  }

  function toggle(id: string, open: boolean, mentionKey: number | undefined) {
    const next = open
      ? opened.filter((entry) => entry !== id)
      : [...opened, id];
    if (search?.revealed.includes(id))
      setSearch({
        ...search,
        revealed: search.revealed.filter((entry) => entry !== id),
      });
    if (openedForJump === id) setOpenedForJump(undefined);
    if (open && mentionKey !== undefined) setCollapsedMentionKey(mentionKey);
    setOpened(next);
    if (peek) return;
    try {
      localStorage.setItem(foldKey(ticketId), JSON.stringify(next));
    } catch {
      // The current opening still works if this device cannot keep it.
    }
  }

  return (
    <div className="ticket-description" ref={root} tabIndex={-1}>
      {search && (
        <div
          className="ticket-description-find"
          role="search"
          aria-label="Find in description"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            closeSearch();
          }}
        >
          <Input
            className="h-7"
            ref={input}
            type="search"
            aria-label="Find in description"
            placeholder="Find in description"
            autoComplete="off"
            spellCheck={false}
            value={search.query}
            onChange={(event) => find(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing)
                return;
              event.preventDefault();
              find(search.query, event.shiftKey ? -1 : 1);
            }}
          />
          {search.query.trim() && (
            <span role="status" className="ticket-description-find-count">
              {search.matches.length
                ? `${search.index + 1} of ${search.matches.length}`
                : "No matches"}
            </span>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-compact"
            aria-label="Previous match"
            disabled={!search.matches.length}
            onClick={() => find(search.query, -1)}
          >
            <ChevronUp aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-compact"
            aria-label="Next match"
            disabled={!search.matches.length}
            onClick={() => find(search.query, 1)}
          >
            <ChevronDown aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-compact"
            aria-label="Close find"
            onClick={closeSearch}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      )}
      <MarkdownDocument
        {...markdown}
        ranges={folds}
        renderRange={(start, children) => {
          const fold = folds.find((fold) => fold.start === start);
          if (!fold) return children;
          const mentionKey =
            mention && mention.start < fold.end && mention.end > fold.start
              ? mention.key
              : undefined;
          const open =
            opened.includes(fold.id) ||
            search?.revealed.includes(fold.id) ||
            openedForJump === fold.id ||
            (mentionKey !== undefined && mentionKey !== collapsedMentionKey);
          return (
            <Fold
              foldId={fold.id}
              label={fold.label}
              open={open}
              onToggle={() => toggle(fold.id, open, mentionKey)}
            >
              {children}
            </Fold>
          );
        }}
      />
    </div>
  );
}
