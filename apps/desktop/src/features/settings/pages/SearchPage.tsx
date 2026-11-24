import { SourceIcon } from "../sources/SourceIcon";
import { emptyCopy } from "@/lib/empty-copy";
import { Fragment, useEffect, useId, useMemo, useRef } from "react";
import { ChevronRight, Search, SearchX, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import {
  SEARCH_PAGE,
  SETTINGS_SECTIONS,
  sourceSection,
  type SettingsPageId,
} from "@/features/settings/settings-sections";
import {
  SETTINGS_ENTRIES,
  searchSettingsFor,
  sourceEntries,
  splitMatch,
  type SettingsEntry,
} from "@/features/settings/settings-search";
import { useChatFeature } from "@/features/chats/use-chats";
import { useSources } from "@/features/settings/sources/use-sources";
import { useSettingsState } from "@/features/settings/use-settings-state";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";
import { SettingsList } from "@/features/settings/layout/SettingsList";
import "@/features/settings/pages/search-page.css";

/** The id ⌘F and Ctrl+F focus when Settings is already on this page. */
export const SEARCH_INPUT_ID = "settings-search-input";

interface PageInfo {
  id: SettingsPageId;
  label: string;
  group: string;
  icon: LucideIcon;
  iconSvg?: string | null | undefined;
}

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/** `text` with the match of `query` marked (semibold, attention underline). */
function Highlighted({ text, query }: { text: string; query: string }) {
  const [before, match, after] = splitMatch(text, query);
  return (
    <Fragment>
      {before}
      {match && <mark>{match}</mark>}
      {after}
    </Fragment>
  );
}

/** Search every setting by name, description or related word. */
export function SearchPage() {
  const { query, setQuery, openPage } = useSettingsState();
  const { entries: sources } = useSources();
  const chat = useChatFeature();
  const input = useRef<HTMLInputElement>(null);
  const statusId = useId();
  // Search opens to its input, not its title.
  useEffect(() => input.current?.focus({ preventScroll: true }), []);

  const { pages, entries } = useMemo(() => {
    const pages = new Map<SettingsPageId, PageInfo>(
      SETTINGS_SECTIONS.map((section) => [section.id, section]),
    );
    const entries: SettingsEntry[] = [...SETTINGS_ENTRIES];
    for (const { connector, saved } of sources) {
      const id = saved?.id ?? connector.provider;
      const section = sourceSection(
        id,
        saved?.name ?? connector.name,
        connector.presentation?.icon_svg,
      );
      pages.set(section.id, section);
      entries.push(
        ...sourceEntries(
          id,
          connector.name,
          connector.schema.fields.map(({ label }) => label),
        ),
      );
    }
    return { pages, entries };
  }, [sources]);

  // Rows that Chat shows, and the Automations page, are listed only while it is on.
  const hits = searchSettingsFor(
    query,
    entries,
    chat.enabled,
    (entry) => pages.get(entry.section)?.label ?? "",
  );
  // Sections in the order of their best hit; rows keep their rank inside.
  const groups: { page: PageInfo; hits: SettingsEntry[] }[] = [];
  for (const hit of hits) {
    const page = pages.get(hit.section);
    if (!page) continue;
    const group = groups.find((candidate) => candidate.page.id === page.id);
    if (group) group.hits.push(hit);
    else groups.push({ page, hits: [hit] });
  }
  const needle = query.trim();
  const status = !needle
    ? "Type to search every setting by name, description or related word."
    : hits.length === 0
      ? "No matches."
      : `${plural(hits.length, "setting", "settings")} in ${plural(
          groups.length,
          "section",
          "sections",
        )}. Choose one to open its page.`;
  const firstSource = sources[0];
  const shortcuts: { id: SettingsPageId; label: string }[] = [
    { id: "appearance", label: "Appearance" },
    { id: "backups", label: "Backups" },
    ...(firstSource
      ? [
          {
            id: `source-${firstSource.saved?.id ?? firstSource.connector.provider}` as const,
            label: firstSource.saved?.name ?? firstSource.connector.name,
          },
        ]
      : []),
  ];

  return (
    <SettingsPage {...SEARCH_PAGE} header={false} focusTitle={false}>
      <div className="settings-search">
        <h1 className="settings-search-title">
          <label htmlFor={SEARCH_INPUT_ID}>Search settings</label>
        </h1>
        <div className="settings-search-field">
          <Search size={16} aria-hidden="true" />
          <Input
            ref={input}
            id={SEARCH_INPUT_ID}
            type="search"
            aria-describedby={statusId}
            placeholder="Try theme, backup or keyboard"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {/* With no match the empty state says it; the status stays for screen readers. */}
        <p
          className={
            needle && hits.length === 0 ? "sr-only" : "settings-search-status"
          }
          id={statusId}
          role="status"
        >
          {status}
        </p>
        {groups.map(({ page, hits: rows }) => {
          const Icon = page.icon;
          const headingId = `${statusId}-${page.id}`;
          return (
            <section
              key={page.id}
              className="settings-search-group"
              aria-labelledby={headingId}
            >
              <div className="settings-search-group-label">
                {page.iconSvg ? (
                  <SourceIcon svg={page.iconSvg} size={16} />
                ) : (
                  <Icon size={16} aria-hidden="true" />
                )}
                <h2 id={headingId}>{page.label}</h2>
                <span>
                  {page.group} · {plural(rows.length, "setting", "settings")}
                </span>
              </div>
              <SettingsList>
                {rows.map((row) => (
                  <a
                    key={row.title}
                    className="settings-search-result"
                    href={`#settings-${page.id}`}
                    onClick={(event) => {
                      event.preventDefault();
                      openPage(page.id);
                    }}
                  >
                    <span className="settings-search-result-text">
                      <span className="settings-list-row-title">
                        <Highlighted text={row.title} query={needle} />
                      </span>
                      <span className="settings-list-row-description">
                        <Highlighted text={row.description} query={needle} />
                      </span>
                    </span>
                    <ChevronRight size={16} aria-hidden="true" />
                  </a>
                ))}
              </SettingsList>
            </section>
          );
        })}
        {needle && hits.length === 0 && (
          // Unboxed, like every view's no-match block.
          <EmptyState
            icon={<SearchX />}
            title={emptyCopy("settings-search", { query: needle }).title}
            description={emptyCopy("settings-search").sentence}
            action={shortcuts.map((shortcut) => (
              <Button
                key={shortcut.id}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => openPage(shortcut.id)}
              >
                {shortcut.label}
              </Button>
            ))}
          />
        )}
      </div>
    </SettingsPage>
  );
}
