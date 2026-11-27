import { SourceIcon } from "../sources/SourceIcon";
import { emptyCopy } from "@/lib/empty-copy";
import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronRight, SearchX, type LucideIcon } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import {
  SEARCH_INPUT_ID,
  SEARCH_PAGE,
  SETTINGS_SECTIONS,
  sourceSection,
  type SettingsPageId,
} from "@/features/settings/settings-sections";
import {
  SETTINGS_ENTRIES,
  supportEntries,
  searchSettingsFor,
  sourceEntries,
  splitMatch,
  type SettingsEntry,
} from "@/features/settings/settings-search";
import { useChatFeature } from "@/features/chats/use-chats";
import { useSources } from "@/features/settings/sources/use-sources";
import { useSettingsState } from "@/features/settings/use-settings-state";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";
import { SettingsList } from "@/features/settings/layout/SettingsList";
import "@/features/settings/pages/search-page.css";

interface PageInfo {
  id: SettingsPageId;
  label: string;
  group: string;
  icon: LucideIcon;
  iconSvg?: string | null | undefined;
}

/** `text` with the match of `query` marked (semibold, underlined). */
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

/**
 * Search every setting by name, description or related word. The query is
 * typed in the field above the nav's groups, which keeps the focus: Enter
 * opens the first result and the arrows move the selection. This page shows
 * what it finds, one flat list, best match first.
 */
export function SearchPage() {
  const { query, openSetting } = useSettingsState();
  const { entries: sources } = useSources();
  const chat = useChatFeature();
  const resultId = useId();

  const { pages, entries } = useMemo(() => {
    const pages = new Map<SettingsPageId, PageInfo>(
      SETTINGS_SECTIONS.map((section) => [section.id, section]),
    );
    const entries: SettingsEntry[] = [...SETTINGS_ENTRIES, ...supportEntries()];
    for (const { connector, saved } of sources) {
      const id = saved?.id ?? connector.provider;
      const label = saved?.name ?? connector.name;
      const section = sourceSection(
        id,
        label,
        connector.presentation?.icon_svg,
      );
      pages.set(section.id, section);
      entries.push(
        ...sourceEntries(
          id,
          connector.name,
          connector.schema.fields.map(({ label }) => label),
          label,
        ),
      );
    }
    return { pages, entries };
  }, [sources]);

  // Clearing the field sends the person back to their page, which takes a
  // moment to fade this one out: keep showing the last results until it has.
  const typed = query.trim();
  const [held, setHeld] = useState(typed);
  if (typed && typed !== held) setHeld(typed);
  const needle = typed || held;
  // Rows that Chat shows, and the Automations page, are listed only while it is on.
  const results = useMemo(
    () =>
      searchSettingsFor(needle, entries, chat.enabled).flatMap((entry) => {
        const page = pages.get(entry.section);
        return page ? [{ entry, page }] : [];
      }),
    [needle, entries, chat.enabled, pages],
  );

  // The first result is selected; a new query starts over.
  const [selection, setSelection] = useState({ needle, index: 0 });
  // A list that shrinks under the same words (a connection removed) keeps the selection on its last result.
  const selected =
    selection.needle === needle
      ? Math.min(selection.index, Math.max(0, results.length - 1))
      : 0;
  const open = (index: number) => {
    const result = results[index];
    if (result) openSetting?.(result.page.id, result.entry.title);
  };
  // The latest of both, for the field's key handler below.
  const keys = useRef({ needle, results: results.length, selected, open });
  useEffect(() => {
    keys.current = { needle, results: results.length, selected, open };
  });
  // On the document, not on the field: a narrow window moves the field into
  // the nav sheet, and closing the sheet drops it, so any element found now
  // may be replaced. Only the nav's field (by its id) drives the results.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !(event.target instanceof Element) ||
        event.target.id !== SEARCH_INPUT_ID
      )
        return;
      const {
        needle: typed,
        results: count,
        selected: current,
        open: openResult,
      } = keys.current;
      if (count === 0 || event.isComposing) return;
      if (event.key === "Enter") {
        event.preventDefault();
        openResult(current);
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setSelection({
          needle: typed,
          index: Math.min(count - 1, Math.max(0, current + step)),
        });
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  // The field keeps the focus, so it names the selected result for screen
  // readers. Set on every render: the field may be a new element since the last.
  useEffect(() => {
    const field = document.getElementById(SEARCH_INPUT_ID);
    if (!field || results.length === 0) return;
    field.setAttribute("aria-activedescendant", `${resultId}-${selected}`);
    return () => field.removeAttribute("aria-activedescendant");
  });
  useEffect(() => {
    if (results.length === 0) return;
    document
      .getElementById(`${resultId}-${selected}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [resultId, selected, results.length]);

  const status = !needle
    ? "Type to search every setting by name, description or related word."
    : results.length === 0
      ? "No results."
      : `${results.length} ${results.length === 1 ? "result" : "results"}.`;

  return (
    // The query is typed in the nav's field, which keeps the focus.
    <SettingsPage {...SEARCH_PAGE} focusTitle={false}>
      <div className="settings-search-body">
        <p
          className={needle ? "sr-only" : "settings-search-status"}
          role="status"
        >
          {status}
        </p>
        {results.length > 0 && (
          <SettingsSection
            className="settings-search"
            title={`${results.length} ${results.length === 1 ? "setting matches" : "settings match"} “${needle}”`}
            caption="Enter opens the first one."
          >
            <SettingsList>
              {results.map(({ entry, page }, index) => {
                const Icon = page.icon;
                return (
                  <a
                    key={`${page.id}:${entry.title}`}
                    id={`${resultId}-${index}`}
                    className="settings-search-result"
                    href={`#settings-${page.id}`}
                    aria-current={index === selected ? "true" : undefined}
                    onClick={(event) => {
                      event.preventDefault();
                      open(index);
                    }}
                  >
                    {page.iconSvg ? (
                      <SourceIcon svg={page.iconSvg} size={16} />
                    ) : (
                      <Icon size={16} aria-hidden="true" />
                    )}
                    <span className="settings-search-result-text">
                      <span className="settings-list-row-title">
                        <Highlighted text={entry.title} query={needle} />
                      </span>
                      <span className="settings-list-row-description">
                        {page.group} › {page.label}
                      </span>
                    </span>
                    <ChevronRight size={16} aria-hidden="true" />
                  </a>
                );
              })}
            </SettingsList>
          </SettingsSection>
        )}
        {needle && results.length === 0 && (
          <section className="settings-section">
            {/* Unboxed, like every view's no-match block. */}
            <EmptyState
              icon={<SearchX />}
              title={emptyCopy("settings-search", { query: needle }).title}
              description={emptyCopy("settings-search").sentence}
            />
          </section>
        )}
      </div>
    </SettingsPage>
  );
}
