import { useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";
import { SEARCH_PAGE } from "@/features/settings/settings-sections";
import { useSettingsState } from "@/features/settings/use-settings-state";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";

/** The id ⌘F and Ctrl+F focus when Settings is already on this page. */
export const SEARCH_INPUT_ID = "settings-search-input";

/** Search settings. A placeholder: the registry and results arrive with the Search page. */
export function SearchPage() {
  const { query, setQuery } = useSettingsState();
  const input = useRef<HTMLInputElement>(null);
  // Search opens to its input, not its title.
  useEffect(() => input.current?.focus({ preventScroll: true }), []);
  return (
    <SettingsPage
      {...SEARCH_PAGE}
      title="Search settings"
      lede="Type to search every setting by name, description or related word."
      focusTitle={false}
    >
      <Input
        ref={input}
        id={SEARCH_INPUT_ID}
        type="search"
        aria-label="Search settings"
        placeholder="Search settings"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
    </SettingsPage>
  );
}
