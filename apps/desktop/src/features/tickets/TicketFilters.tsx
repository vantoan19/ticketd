import { IconButton } from "@/components/ui/icon-button";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Search, SlidersHorizontal, X } from "lucide-react";
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
};

export function TicketFilters(p: Props) {
  const update = (setter: (value: string) => void, value: string) => {
    setter(value);
    p.setOffset(0);
  };
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
    ...p.tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)
      .map((tag, index, all) => ({
        label: `Tag: ${tag}`,
        clear: () =>
          update(
            p.setTags,
            all.filter((_, position) => position !== index).join(", "),
          ),
      })),
    p.navigation.kind !== "ready" &&
      p.availability && {
        label: `Availability: ${p.availability}`,
        clear: () => update(p.setAvailability, ""),
      },
    p.family && {
      label: `Family: ${p.family}`,
      clear: () => update(p.setFamily, ""),
    },
  ].filter((chip): chip is { label: string; clear: () => void } =>
    Boolean(chip),
  );
  const filterCount = chips.length - (p.query.trim() ? 1 : 0);
  return (
    <>
      {p.part !== "chips" && (
        <div className="list-controls">
          <Popover>
            <PopoverTrigger asChild>
              <IconButton
                label={
                  p.query ? `Search tickets: ${p.query}` : "Search tickets"
                }
              >
                <Search />
              </IconButton>
            </PopoverTrigger>
            <PopoverContent align="end" aria-label="Search tickets">
              <label className="search">
                <Search size={16} />
                <span className="sr-only">Search tickets</span>
                <Input
                  aria-label="Search tickets"
                  placeholder="Search tickets…"
                  value={p.query}
                  onChange={(event) => update(p.setQuery, event.target.value)}
                />
              </label>
            </PopoverContent>
          </Popover>
          <Popover>
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
              align="end"
              aria-label="Ticket filters"
            >
              <FieldSet>
                <FieldLegend>Filters</FieldLegend>
                <FieldGroup>
                  {!p.navigation.plan && (
                    <FilterSelect
                      label="Plan"
                      value={p.plan}
                      onChange={(value) => update(p.setPlan, value)}
                      all="All Plans"
                      options={p.plans.map((item) => ({
                        value: item.id,
                        label: `${item.name}${item.archived ? " (archived)" : ""}`,
                      }))}
                    />
                  )}
                  {p.navigation.kind !== "progress" && (
                    <FilterSelect
                      label="Status"
                      value={p.status}
                      onChange={(value) => update(p.setStatus, value)}
                      all="All statuses"
                      options={ticketStatuses.map((value) => ({
                        value,
                        label: value,
                      }))}
                    />
                  )}
                  <Field>
                    <FieldLabel htmlFor="filter-tags">
                      Tags (comma separated; all tags required)
                    </FieldLabel>
                    <Input
                      id="filter-tags"
                      value={p.tags}
                      onChange={(event) =>
                        update(p.setTags, event.target.value)
                      }
                    />
                  </Field>
                  {p.navigation.kind !== "ready" && (
                    <FilterSelect
                      label="Availability"
                      value={p.availability}
                      onChange={(value) => update(p.setAvailability, value)}
                      all="All availability"
                      options={["Ready", "Blocked"].map((value) => ({
                        value,
                        label: value,
                      }))}
                    />
                  )}
                  <Field>
                    <FieldLabel htmlFor="filter-family">
                      Parent ticket
                    </FieldLabel>
                    <Input
                      id="filter-family"
                      value={p.family}
                      onChange={(event) =>
                        update(p.setFamily, event.target.value)
                      }
                    />
                  </Field>
                </FieldGroup>
              </FieldSet>
            </PopoverContent>
          </Popover>
        </div>
      )}
      {p.part !== "controls" && chips.length > 0 && (
        <div className="filter-chips" aria-label="Active filters">
          <span>Filters</span>
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

function FilterSelect({
  label,
  value,
  onChange,
  all,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  all: string;
  options: { value: string; label: string }[];
}) {
  const id = `filter-${label.toLowerCase()}`;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        value={value || "__all"}
        onValueChange={(next) => onChange(next === "__all" ? "" : next)}
      >
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="__all">{all}</SelectItem>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}
