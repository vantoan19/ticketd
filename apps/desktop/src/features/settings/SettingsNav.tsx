import { useEffect } from "react";
import { ArrowLeft, Search, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Kbd } from "@/components/ui/kbd";
import { Glide } from "@/components/ui/motion";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tooltip } from "@/components/ui/tooltip";
import { StatusDot, type StatusDotTone } from "@/components/ui/status-dot";
import { useChatFeature } from "@/features/chats/use-chats";
import { useIsMobile } from "@/hooks/use-mobile";
import { modifierKeyLabel } from "@/lib/platform";
import {
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  sourceSection,
  type SettingsGroup,
  type SettingsPageId,
} from "@/features/settings/settings-sections";
import { useSettingsState } from "@/features/settings/use-settings-state";
import { useUpdates } from "@/features/updates/update-state";
import { useSources } from "@/features/settings/sources/use-sources";
import "@/features/settings/settings.css";

interface NavItem {
  id: SettingsPageId;
  label: string;
  group: SettingsGroup;
  icon: LucideIcon;
}

interface NavIndicator {
  label: string;
  tone: StatusDotTone;
}

/**
 * The nav's items and the dot each carries: "Needs setup" (attention) on
 * Command line, Agent skills and Chat when the page would ask for a step;
 * "Connected" (positive) on a source with a saved configuration. The page
 * says the same words in its StatusLabel.
 */
function useSettingsNavItems() {
  const { entries } = useSources();
  const { needsSetup } = useSettingsState();
  const chat = useChatFeature();
  const update = useUpdates()?.snapshot;
  const items: NavItem[] = [
    // Automations are part of Chat: its switch shows and hides both.
    ...SETTINGS_SECTIONS.filter(
      (section) => section.id !== "automations" || chat.enabled,
    ),
    ...entries.map(({ connector }) =>
      sourceSection(connector.provider, connector.name),
    ),
  ];
  const indicator = (id: SettingsPageId): NavIndicator | null => {
    if (id === "about" && update?.status === "ready" && update.dismissed)
      return { label: "Update ready", tone: "unread" };
    if (
      (id === "command-line" || id === "agent-skills" || id === "chat") &&
      needsSetup[id]
    )
      return { label: "Needs setup", tone: "attention" };
    if (
      entries.some(
        (entry) => `source-${entry.connector.provider}` === id && entry.saved,
      )
    )
      return { label: "Connected", tone: "positive" };
    return null;
  };
  return { items, indicator };
}

/**
 * Takes the workspace sidebar's place while Settings is open. Below 768px the
 * same nav opens as the navigation sheet, from the page trigger in the panel
 * bar, like the workspace's own navigation.
 */
export function SettingsNav({
  onBack,
  resolveReturnFocus,
  origin = "tickets",
  selected = "appearance",
  onSelect,
}: {
  onBack: () => void;
  resolveReturnFocus?: () => HTMLElement | null;
  /** Where Back returns, by name ("tickets", "Attachments"): shell SH-21. */
  origin?: string;
  selected?: SettingsPageId;
  onSelect?: (page: SettingsPageId) => void;
}) {
  const { items, indicator } = useSettingsNavItems();
  const { query, navOpen = false, setNavOpen = () => {} } = useSettingsState();
  const mobile = useIsMobile();
  useEffect(() => {
    if (!mobile && navOpen) setNavOpen(false);
  }, [mobile, navOpen, setNavOpen]);
  const modifier = modifierKeyLabel();
  const findHint = modifier === "Ctrl" ? "Ctrl+F" : `${modifier}F`;
  const shown = query.trim();
  const open = (page: SettingsPageId) => {
    setNavOpen(false);
    onSelect?.(page);
  };
  const content = (
    <>
      <button
        type="button"
        className="settings-back"
        data-responsive-navigation="settings-back"
        onClick={() => {
          setNavOpen(false);
          onBack();
        }}
      >
        <ArrowLeft size={16} aria-hidden="true" /> Back to {origin}
      </button>
      <nav aria-label="Settings sections">
        {/* A nav row like the others: the input is drawn on the Search page only. */}
        <button
          type="button"
          className="settings-nav-row settings-search-entry"
          data-responsive-navigation="settings-section:search"
          aria-current={selected === "search" ? "page" : undefined}
          onClick={() => open("search")}
        >
          {selected === "search" && <Glide id="settings-nav" />}
          <Search size={16} aria-hidden="true" />
          <span className="settings-nav-label">
            {shown ? (
              <>
                <span className="sr-only">Search settings: </span>
                <span className="settings-nav-query">“{shown}”</span>
              </>
            ) : (
              "Search settings"
            )}
          </span>
          <Kbd aria-hidden="true">{findHint}</Kbd>
        </button>
        {SETTINGS_GROUPS.map((group) => {
          const sections = items.filter((item) => item.group === group);
          if (sections.length === 0) return null;
          return (
            <div key={group} role="group" aria-label={group}>
              <p className="settings-nav-heading" aria-hidden="true">
                {group}
              </p>
              <ul>
                {sections.map((item) => {
                  const dot = indicator(item.id);
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        className="settings-nav-row"
                        data-responsive-navigation={`settings-section:${item.id}`}
                        aria-current={selected === item.id ? "page" : undefined}
                        onClick={() => open(item.id)}
                      >
                        {selected === item.id && <Glide id="settings-nav" />}
                        <item.icon size={16} aria-hidden="true" />
                        <span className="settings-nav-label">{item.label}</span>
                        {item.id === "chat" && (
                          <Badge variant="experimental">Experimental</Badge>
                        )}
                        {dot && (
                          <Tooltip content={dot.label} side="right">
                            <span
                              role="img"
                              aria-label={dot.label}
                              className="settings-nav-dot"
                            >
                              <StatusDot tone={dot.tone} />
                            </span>
                          </Tooltip>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>
    </>
  );
  if (mobile)
    return (
      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        <SheetContent
          {...(resolveReturnFocus && { resolveReturnFocus })}
          side="left"
          showCloseButton={false}
          size="nav"
          aria-label="Settings"
        >
          <SheetTitle className="sr-only">Settings</SheetTitle>
          <SheetDescription className="sr-only">
            Settings sections.
          </SheetDescription>
          <div className="settings-nav settings-nav-sheet">{content}</div>
        </SheetContent>
      </Sheet>
    );
  return (
    <aside className="settings-nav" aria-label="Settings">
      {content}
    </aside>
  );
}
