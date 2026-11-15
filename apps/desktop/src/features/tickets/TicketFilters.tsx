import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  CircleDashed,
  CornerDownRight,
  Layers,
  ListFilter,
  Search,
  Tag,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Count } from "@/components/ui/count";
import { FilterChip } from "@/components/ui/badge";
import { IconButton } from "@/components/ui/icon-button";
import { PaneHeaderButton } from "@/components/ui/list-header";
import { SearchInput } from "@/components/ui/search-input";
import { StatusDot } from "@/components/ui/status-dot";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { plural } from "@/lib/format";
import { client, type StatusCounts } from "@/lib/api/client";
import { ticketStatuses } from "@/lib/statuses";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import { TicketPicker } from "./TicketPicker";
import {
  useFiltersMenu,
  type Dimension,
  type FiltersMenuState,
} from "./filters-menu";
import "./ticket-filters.css";

type Props = {
  part?: "controls" | "chips";
  query: string;
  setQuery: (value: string) => void;
  plan: string;
  setPlan: (value: string) => void;
  status: string;
  setStatus: (value: string) => void;
  tags: string;
  setTags: (value: string) => void;
  availability: string;
  setAvailability: (value: string) => void;
  family: string;
  setFamily: (value: string) => void;
  plans: { id: string; name: string; archived: boolean }[];
  /** Starts the list again at its first page. */
  resetPaging: () => void;
  navigation: {
    kind: "all" | "ready" | "progress" | "trash";
    project: string;
    plan: string;
  };
  /** Clears the filter dimensions only; the search and source tabs stay. */
  clearFilters: () => void;
  /** Name of the scope the list shows, for the search placeholder. */
  scopeName: string;
  /** Tickets matching now, and what the scope holds before narrowing. */
  total: number;
  scopeTotal: number | null;
  /** Per-status totals of the current result, for the Status submenu. */
  counts?: StatusCounts | null;
  /**
   * The menu's open state and its open submenu, shared by the header's
   * trigger and the chip row (a chip reopens its own submenu).
   */
  menu?: FiltersMenuState;
};

/** Which dimensions apply in this view, and the value each has now. */
function dimensions(p: Props) {
  const tagList = p.tags
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  const update = (setter: (value: string) => void, value: string) => {
    setter(value);
    p.resetPaging();
  };
  const shown = {
    // The In progress view is a status; the Ready view is an availability; a
    // Plan's own list is that Plan. Their dimension would only repeat it.
    Status: p.navigation.kind !== "progress",
    Availability: p.navigation.kind !== "ready",
    Plan: !p.navigation.plan,
    Tags: true,
    Parent: true,
  } satisfies Record<Dimension, boolean>;
  const planName = (id: string) =>
    p.plans.find((item) => item.id === id)?.name ?? id;
  const chips: {
    dimension: Dimension;
    value: string;
    clear: () => void;
  }[] = [];
  if (shown.Status && p.status)
    chips.push({
      dimension: "Status",
      value: p.status,
      clear: () => update(p.setStatus, ""),
    });
  if (shown.Availability && p.availability)
    chips.push({
      dimension: "Availability",
      value: p.availability,
      clear: () => update(p.setAvailability, ""),
    });
  if (shown.Plan && p.plan)
    chips.push({
      dimension: "Plan",
      value: planName(p.plan),
      clear: () => update(p.setPlan, ""),
    });
  // One chip for every tag (list F-08): "Tags  board, ui".
  if (tagList.length)
    chips.push({
      dimension: "Tags",
      value: tagList.join(", "),
      clear: () => update(p.setTags, ""),
    });
  if (p.family)
    chips.push({
      dimension: "Parent",
      value: p.family,
      clear: () => update(p.setFamily, ""),
    });
  return { shown, chips, tagList, update };
}

/**
 * Search and Filters for a ticket list (DESIGN.md section 6, S3).
 *
 * - `controls`: the header's Search button (it expands in place) and the
 *   Filters menu: one submenu per dimension built from menu rows with icons,
 *   a trailing check on the current value and counts where they are cheap.
 *   It opens below its trigger inside the list pane, never over the open
 *   ticket, and with focus on its first row.
 * - `chips`: one chip per active dimension on one line under the header
 *   ("Status  In review ×", "Tags  board, ui ×"), "+2 more" when they do not
 *   fit, then "Clear filters", which clears the filters and nothing else.
 *   Clicking a chip reopens its submenu.
 */
export function TicketFilters(p: Props) {
  const own = useFiltersMenu();
  const menu = p.menu ?? own;
  const { chips } = dimensions(p);
  if (p.part === "chips") return <FilterChips {...p} menu={menu} />;
  return (
    <span className="list-controls">
      <HeaderSearch {...p} />
      <FiltersMenu {...p} menu={menu} filterCount={chips.length} />
      {p.part !== "controls" && <FilterChips {...p} menu={menu} />}
    </span>
  );
}

/** The header's search: an icon button that expands into the field in place. */
function HeaderSearch(p: Props) {
  const [searching, setSearching] = useState(false);
  const update = (value: string) => {
    p.setQuery(value);
    p.resetPaging();
  };
  if (!searching)
    return (
      <IconButton
        label={p.query ? `Search tickets: ${p.query}` : "Search tickets"}
        onClick={() => setSearching(true)}
      >
        <Search />
      </IconButton>
    );
  return (
    <span className="header-search" role="search" data-slot="pane-search">
      <SearchInput
        fill
        aria-label="Search tickets"
        placeholder={`Search ${p.scopeName}…`}
        autoFocus
        value={p.query}
        onValueChange={update}
        onKeyDown={(event) => {
          // A first Escape clears the words (SearchInput); the next closes.
          if (event.key === "Escape") {
            event.stopPropagation();
            setSearching(false);
          }
        }}
      />
      {p.query.trim() && (
        <span role="status" className="header-search-count">
          {plural(p.total, "result")}
          <span className="sr-only"> in {p.scopeName}</span>
        </span>
      )}
      <IconButton label="Close search" onClick={() => setSearching(false)}>
        <X />
      </IconButton>
    </span>
  );
}

function FiltersMenu(
  p: Props & { menu: FiltersMenuState; filterCount: number },
) {
  const { menu, filterCount } = p;
  const { shown, tagList, update } = dimensions(p);
  const [vocabulary, setVocabulary] = useState<string[]>([]);
  useEffect(() => {
    if (!menu.open) return;
    let active = true;
    void client.searchTags("").then(
      (tags) => {
        if (active) setVocabulary(tags);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [menu.open]);
  const allTags = [...new Set([...tagList, ...vocabulary])];
  const activePlans = p.plans.filter((item) => !item.archived);
  const archivedPlans = p.plans.filter((item) => item.archived);
  // Per-status totals mean something only while no status narrows them.
  const statusCount = (status: string) => {
    if (p.status || !p.counts) return undefined;
    const key = status.toLowerCase().replace(" ", "_") as keyof StatusCounts;
    const value = p.counts[key];
    return typeof value === "number" ? value : undefined;
  };
  const sub = (dimension: Dimension) => ({
    open: menu.sub === dimension,
    onOpenChange: (open: boolean) =>
      menu.setSub(open ? dimension : menu.sub === dimension ? null : menu.sub),
  });
  const valueMeta = (value: string | undefined) =>
    value ? <span className="filters-menu-value">{value}</span> : null;
  return (
    <DropdownMenu open={menu.open} onOpenChange={menu.setOpen}>
      <DropdownMenuTrigger asChild>
        <PaneHeaderButton
          icon={<ListFilter />}
          label="Filters"
          aria-label={
            filterCount ? `Filters, ${filterCount} active` : "Filters"
          }
        >
          {filterCount > 0 && <Count aria-hidden="true">{filterCount}</Count>}
        </PaneHeaderButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {shown.Status && (
          <DropdownMenuSub {...sub("Status")}>
            <DropdownMenuSubTrigger>
              <StatusIcon status={p.status || "Todo"} decorative />
              Status
              {valueMeta(p.status)}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent aria-label="Status">
              <DropdownMenuRadioGroup
                value={p.status}
                onValueChange={(value) => update(p.setStatus, value)}
              >
                {ticketStatuses.map((status) => (
                  <DropdownMenuRadioItem key={status} value={status}>
                    <StatusIcon status={status} decorative />
                    {status}
                    <MenuCount value={statusCount(status)} />
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              {p.status && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => update(p.setStatus, "")}>
                    <X aria-hidden="true" />
                    Any status
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {shown.Availability && (
          <DropdownMenuSub {...sub("Availability")}>
            <DropdownMenuSubTrigger>
              <CircleDashed aria-hidden="true" />
              Availability
              {valueMeta(p.availability)}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent aria-label="Availability">
              <DropdownMenuRadioGroup
                value={p.availability}
                onValueChange={(value) => update(p.setAvailability, value)}
              >
                <DropdownMenuRadioItem value="Ready">
                  <span className="filters-menu-dot" aria-hidden="true">
                    <StatusDot tone="ready" size={8} />
                  </span>
                  Ready
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="Blocked">
                  <span className="filters-menu-dot" aria-hidden="true">
                    <StatusDot tone="blocked" size={8} />
                  </span>
                  Blocked
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              {p.availability && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => update(p.setAvailability, "")}
                  >
                    <X aria-hidden="true" />
                    Any availability
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {shown.Plan && (
          <DropdownMenuSub {...sub("Plan")}>
            <DropdownMenuSubTrigger>
              <Layers aria-hidden="true" />
              Plan
              {valueMeta(
                p.plan
                  ? (p.plans.find((item) => item.id === p.plan)?.name ?? "")
                  : undefined,
              )}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent aria-label="Plan">
              {p.plans.length === 0 && (
                <DropdownMenuItem disabled>No Plans yet</DropdownMenuItem>
              )}
              <DropdownMenuRadioGroup
                value={p.plan}
                onValueChange={(value) => update(p.setPlan, value)}
              >
                {activePlans.map((item) => (
                  <DropdownMenuRadioItem key={item.id} value={item.id}>
                    <Layers aria-hidden="true" />
                    <span className="truncate">{item.name}</span>
                  </DropdownMenuRadioItem>
                ))}
                {/* Archived Plans come last under their own label (list F-06). */}
                {archivedPlans.length > 0 && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>Archived</DropdownMenuLabel>
                    {archivedPlans.map((item) => (
                      <DropdownMenuRadioItem key={item.id} value={item.id}>
                        <Layers aria-hidden="true" />
                        <span className="truncate">{item.name}</span>
                      </DropdownMenuRadioItem>
                    ))}
                  </>
                )}
              </DropdownMenuRadioGroup>
              {p.plan && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => update(p.setPlan, "")}>
                    <X aria-hidden="true" />
                    Any Plan
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        <DropdownMenuSub {...sub("Tags")}>
          <DropdownMenuSubTrigger>
            <Tag aria-hidden="true" />
            Tags
            {valueMeta(tagList.length ? String(tagList.length) : undefined)}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent aria-label="Tags" className="max-h-80">
            {allTags.length === 0 && (
              <DropdownMenuItem disabled>No tags yet</DropdownMenuItem>
            )}
            {allTags.map((tag) => (
              <DropdownMenuCheckboxItem
                key={tag}
                checked={tagList.includes(tag)}
                onCheckedChange={(checked) =>
                  update(
                    p.setTags,
                    (checked
                      ? [...tagList, tag]
                      : tagList.filter((item) => item !== tag)
                    ).join(", "),
                  )
                }
              >
                <Tag aria-hidden="true" />
                <span className="truncate">{tag}</span>
              </DropdownMenuCheckboxItem>
            ))}
            {allTags.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <p className="filters-menu-caption">
                  Tickets must have every tag you check.
                </p>
              </>
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub {...sub("Parent")}>
          <DropdownMenuSubTrigger>
            <CornerDownRight aria-hidden="true" />
            Parent
            {valueMeta(p.family || undefined)}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent aria-label="Parent" className="w-80">
            {/* The picker owns its keys: arrows move its rows and typing
                searches, rather than closing the submenu or jumping rows. */}
            <div
              onKeyDown={(event) => {
                if (event.key !== "Escape" && event.key !== "Tab")
                  event.stopPropagation();
              }}
            >
              <TicketPicker
                label="Parent ticket"
                onPick={(ticket) => {
                  update(p.setFamily, ticket.reference);
                  menu.setOpen(false);
                }}
                caption={(ticket) =>
                  ticket.reference === p.family ? "Current" : undefined
                }
              />
            </div>
            {p.family && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => update(p.setFamily, "")}>
                  <X aria-hidden="true" />
                  Any parent
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MenuCount({ value }: { value: number | undefined }) {
  if (value === undefined) return null;
  return <span className="filters-menu-count">{value}</span>;
}

/**
 * The active filters on one line: a chip per dimension, "+N more" for the
 * ones that do not fit (it opens the menu), then Clear filters. A search is a
 * chip too, so a closed search still shows what narrows the list.
 */
function FilterChips(p: Props & { menu: FiltersMenuState }) {
  const { chips } = dimensions(p);
  const query = p.query.trim();
  const all = [
    ...(query
      ? [
          {
            dimension: "Search" as const,
            value: query,
            clear: () => {
              p.setQuery("");
              p.resetPaging();
            },
          },
        ]
      : []),
    ...chips,
  ];
  const row = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState(all.length);
  const key = all.map((chip) => `${chip.dimension}:${chip.value}`).join("|");
  // Measure with every chip drawn, then hide from the end whatever overflows,
  // keeping room for "+N more" and Clear filters. Chips never wrap (list F-08).
  useLayoutEffect(() => {
    const element = row.current;
    if (!element) return;
    const measure = () => {
      const items = [
        ...element.querySelectorAll<HTMLElement>("[data-filter-chip]"),
      ];
      const tail = element.querySelector<HTMLElement>("[data-filter-tail]");
      const limit =
        element.clientWidth -
        (tail?.offsetWidth ?? 0) -
        // The "+N more" button, when some chips will be hidden.
        72;
      let count = 0;
      for (const item of items) {
        if (item.offsetLeft + item.offsetWidth > limit && count > 0) break;
        count += 1;
      }
      const everything =
        items.length === 0 ||
        (items.at(-1)!.offsetLeft + items.at(-1)!.offsetWidth <=
          element.clientWidth - (tail?.offsetWidth ?? 0) &&
          items.length === all.length);
      setFits(everything ? all.length : Math.max(1, count));
    };
    setFits(all.length);
    const frame = requestAnimationFrame(measure);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            setFits(all.length);
            requestAnimationFrame(measure);
          });
    observer?.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [key, all.length]);
  if (all.length === 0) return null;
  const hidden = all.length - fits;
  return (
    <div ref={row} className="filter-chips" aria-label="Active filters">
      {all.slice(0, fits).map((chip) => (
        <span key={chip.dimension} data-filter-chip="">
          <FilterChip
            dimension={chip.dimension}
            value={chip.value}
            removeLabel={
              chip.dimension === "Search"
                ? `Remove Search: ${chip.value}`
                : `Remove ${chip.dimension} filter`
            }
            onRemove={chip.clear}
            {...(chip.dimension !== "Search" && {
              onEdit: () => {
                p.menu.setOpen(true);
                p.menu.setSub(chip.dimension as Dimension);
              },
            })}
          />
        </span>
      ))}
      {hidden > 0 && (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`${hidden} more ${hidden === 1 ? "filter" : "filters"}`}
          onClick={() => p.menu.setOpen(true)}
        >
          +{hidden} more
        </Button>
      )}
      {chips.length > 0 && (
        <span data-filter-tail="" className="filter-chips-tail">
          <Button variant="ghost" size="sm" onClick={p.clearFilters}>
            Clear filters
          </Button>
        </span>
      )}
    </div>
  );
}
