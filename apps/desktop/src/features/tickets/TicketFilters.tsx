import { useEffect, useState, type ReactNode } from "react";
import { IconButton } from "@/components/ui/icon-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Picker } from "@/components/ui/picker";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { client, type Ticket } from "@/lib/api/client";
import { ticketStatuses } from "@/lib/statuses";
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
  setOffset: (value: number) => void;
  navigation: {
    kind: "all" | "ready" | "progress" | "trash";
    project: string;
    plan: string;
  };
  clearFilters: () => void;
  /** Name of the scope the list shows, for the search count. */
  scopeName: string;
  /** Tickets matching now, and what the scope holds before narrowing. */
  total: number;
  scopeTotal: number | null;
};

export function TicketFilters(p: Props) {
  const [searching, setSearching] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const update = (setter: (value: string) => void, value: string) => {
    setter(value);
    p.setOffset(0);
  };
  const tagList = p.tags
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  const setTagList = (next: string[]) => update(p.setTags, next.join(", "));
  const chips = [
    p.query.trim() && {
      label: `Search: ${p.query.trim()}`,
      clear: () => update(p.setQuery, ""),
    },
    !p.navigation.plan &&
      p.plan && {
        label: `Plan: ${p.plans.find((item) => item.id === p.plan)?.name ?? p.plan}`,
        clear: () => update(p.setPlan, ""),
      },
    p.navigation.kind !== "progress" &&
      p.status && {
        label: `Status: ${p.status}`,
        clear: () => update(p.setStatus, ""),
      },
    ...tagList.map((tag) => ({
      label: `Tag: ${tag}`,
      clear: () => setTagList(tagList.filter((item) => item !== tag)),
    })),
    p.navigation.kind !== "ready" &&
      p.availability && {
        label: `Availability: ${p.availability}`,
        clear: () => update(p.setAvailability, ""),
      },
    p.family && {
      label: `Parent: ${p.family}`,
      clear: () => update(p.setFamily, ""),
    },
  ].filter((chip): chip is { label: string; clear: () => void } =>
    Boolean(chip),
  );
  const filterCount = chips.length - (p.query.trim() ? 1 : 0);
  const ofTotal = `${p.total} of ${p.scopeTotal ?? p.total}`;
  return (
    <>
      {p.part !== "chips" && (
        <div className="list-controls">
          {searching ? (
            <div className="header-search" role="search">
              <Search size={16} aria-hidden="true" />
              <Input
                aria-label="Search tickets"
                placeholder="Search tickets…"
                autoFocus
                value={p.query}
                onChange={(event) => update(p.setQuery, event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setSearching(false);
                  }
                }}
              />
              {p.query.trim() && (
                <span role="status" className="header-search-count">
                  {p.total} {p.total === 1 ? "result" : "results"} in{" "}
                  {p.scopeName}
                </span>
              )}
              <Kbd>Esc</Kbd>
              <IconButton
                label="Close search"
                onClick={() => setSearching(false)}
              >
                <X />
              </IconButton>
            </div>
          ) : (
            <IconButton
              label={p.query ? `Search tickets: ${p.query}` : "Search tickets"}
              onClick={() => setSearching(true)}
            >
              <Search />
            </IconButton>
          )}
          <Popover open={filtersOpen} onOpenChange={setFiltersOpen}>
            <PopoverTrigger asChild>
              <IconButton
                label={
                  filterCount ? `Filters, ${filterCount} active` : "Filters"
                }
                aria-label={
                  filterCount ? `Filters, ${filterCount} active` : "Filters"
                }
              >
                <SlidersHorizontal />
                {filterCount > 0 && (
                  <span className="filter-count">{filterCount}</span>
                )}
              </IconButton>
            </PopoverTrigger>
            <PopoverContent
              className="filters-content"
              side="right"
              align="start"
              aria-label="Ticket filters"
            >
              <div className="filters-head">
                <h2>Filters</h2>
                <Button variant="ghost" size="sm" onClick={p.clearFilters}>
                  Clear all
                </Button>
              </div>
              {p.navigation.kind !== "progress" && (
                <FilterSection label="Status">
                  <div className="toggle-chips">
                    {ticketStatuses.map((value) => (
                      <ToggleChip
                        key={value}
                        pressed={p.status === value}
                        onToggle={() =>
                          update(p.setStatus, p.status === value ? "" : value)
                        }
                      >
                        {value}
                      </ToggleChip>
                    ))}
                  </div>
                </FilterSection>
              )}
              {p.navigation.kind !== "ready" && (
                <FilterSection label="Availability">
                  <SegmentedControl
                    aria-label="Availability"
                    value={p.availability || "Any"}
                    onValueChange={(value) =>
                      update(p.setAvailability, value === "Any" ? "" : value)
                    }
                    options={["Any", "Ready", "Blocked"].map((value) => ({
                      value,
                      label: value,
                    }))}
                  />
                </FilterSection>
              )}
              {!p.navigation.plan && (
                <FilterSection label="Plan">
                  <Picker
                    label="Plan"
                    value={p.plan || "__any"}
                    onValueChange={(value) =>
                      update(p.setPlan, value === "__any" ? "" : value)
                    }
                    options={[
                      { value: "__any", label: "Any Plan" },
                      ...p.plans.map((item) => ({
                        value: item.id,
                        label: `${item.name}${item.archived ? " (archived)" : ""}`,
                      })),
                    ]}
                  />
                </FilterSection>
              )}
              <FilterSection label="Tags">
                <TagChips
                  open={filtersOpen}
                  selected={tagList}
                  onChange={setTagList}
                />
                <p className="filter-hint">
                  Tickets must have every tag you pick.
                </p>
              </FilterSection>
              <FilterSection label="Parent ticket">
                <ParentSearch
                  value={p.family}
                  onChange={(value) => update(p.setFamily, value)}
                />
              </FilterSection>
              <div className="filters-foot">
                <span role="status">
                  {ofTotal} {p.total === 1 ? "ticket matches" : "tickets match"}
                </span>
                <Button size="sm" onClick={() => setFiltersOpen(false)}>
                  Done
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      )}
      {p.part !== "controls" && chips.length > 0 && (
        <div className="filter-chips" aria-label="Active filters">
          <span className="filter-match-count">{ofTotal}</span>
          {chips.map((chip, index) => (
            <Button
              key={`${chip.label}-${index}`}
              variant="outline"
              size="sm"
              aria-label={`Remove ${chip.label}`}
              onClick={chip.clear}
            >
              {chip.label}
              <X data-icon="inline-end" />
            </Button>
          ))}
          <Button variant="ghost" size="sm" onClick={p.clearFilters}>
            Clear filters
          </Button>
        </div>
      )}
    </>
  );
}

function FilterSection({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <section className="filter-section" aria-label={label}>
      <h3>{label}</h3>
      {children}
    </section>
  );
}

function ToggleChip({
  pressed,
  onToggle,
  children,
}: {
  pressed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant={pressed ? "default" : "outline"}
      size="sm"
      aria-pressed={pressed}
      onClick={onToggle}
    >
      {children}
    </Button>
  );
}

/** Every tag in the workspace as a toggle; picked tags stay shown if unknown. */
function TagChips({
  open,
  selected,
  onChange,
}: {
  open: boolean;
  selected: string[];
  onChange: (tags: string[]) => void;
}) {
  const [vocabulary, setVocabulary] = useState<string[]>([]);
  useEffect(() => {
    if (!open) return;
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
  }, [open]);
  const all = [...new Set([...vocabulary, ...selected])];
  if (all.length === 0) return <p className="filter-hint">No tags yet.</p>;
  return (
    <div className="toggle-chips">
      {all.map((tag) => (
        <ToggleChip
          key={tag}
          pressed={selected.includes(tag)}
          onToggle={() =>
            onChange(
              selected.includes(tag)
                ? selected.filter((item) => item !== tag)
                : [...selected, tag],
            )
          }
        >
          {tag}
        </ToggleChip>
      ))}
    </div>
  );
}

/** Finds a parent by title or T-number and sets its reference as the filter. */
function ParentSearch({
  value,
  onChange,
}: {
  value: string;
  onChange: (reference: string) => void;
}) {
  const [text, setText] = useState("");
  const [found, setFound] = useState<Ticket[]>([]);
  useEffect(() => {
    const query = text.trim();
    if (!query) return;
    let active = true;
    void client
      .findTickets({
        query,
        project: null,
        unlinked: false,
        plan: null,
        status: null,
        tags: [],
        availability: null,
        family: null,
        order: "Newest",
        limit: 5,
        offset: 0,
      })
      .then(
        (tickets) => {
          if (active) setFound(tickets);
        },
        () => {},
      );
    return () => {
      active = false;
    };
  }, [text]);
  if (value)
    return (
      <Button
        variant="outline"
        size="sm"
        aria-label={`Remove parent ${value}`}
        onClick={() => onChange("")}
      >
        {value}
        <X data-icon="inline-end" />
      </Button>
    );
  const results = text.trim() ? found : [];
  return (
    <div className="parent-search">
      <Input
        aria-label="Find a parent ticket"
        placeholder="Find a parent by title or T-number"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {results.length > 0 && (
        <ul aria-label="Parent matches">
          {results.map((ticket) => (
            <li key={ticket.reference}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  onChange(ticket.reference);
                  setText("");
                }}
              >
                <span className="text-muted-foreground">
                  {ticket.reference}
                </span>{" "}
                {ticket.title}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
