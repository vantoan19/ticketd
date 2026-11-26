import { useEffect } from "react";
import { ArrowLeft, ListChecks, type LucideIcon } from "lucide-react";
import { SearchInput } from "@/components/ui/search-input";
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
import {
  SEARCH_INPUT_ID,
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  navSectionOf,
  resolveSettingsPage,
  type LegacySettingsPageId,
  type SettingsGroup,
  type SettingsPageId,
  type SettingsSectionId,
} from "@/features/settings/settings-sections";
import { useSettingsState } from "@/features/settings/use-settings-state";
import { SetupRing } from "@/features/setup/SetupRing";
import { useUpdates } from "@/features/updates/update-state";
import "@/features/settings/settings.css";

interface NavItem {
  id: SettingsSectionId;
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
 * Command line, Agent skills and Agents when the page would ask for a step. The
 * page says the same words in its StatusLabel.
 */
function useSettingsNavItems() {
  const { needsSetup } = useSettingsState();
  const chat = useChatFeature();
  const update = useUpdates()?.snapshot;
  // Automations are part of Chats: their switch shows and hides both.
  // Set up ticketd has a row of its own above the groups (see SettingsNav).
  const items: NavItem[] = SETTINGS_SECTIONS.filter(
    (section) =>
      section.id !== "setup" && (section.id !== "automations" || chat.enabled),
  );
  const indicator = (id: SettingsSectionId): NavIndicator | null => {
    if (id === "about" && update?.status === "ready" && update.dismissed)
      return { label: "Update ready", tone: "unread" };
    if (
      (id === "command-line" || id === "agent-skills" || id === "agents") &&
      needsSetup[id]
    )
      return { label: "Needs setup", tone: "attention" };
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
  selected: chosen = "appearance",
  onSelect,
}: {
  onBack: () => void;
  resolveReturnFocus?: () => HTMLElement | null;
  /** Where Back returns, by name ("tickets", "Files"): shell SH-21. */
  origin?: string;
  /** The open page, under its current or an old name; a connection selects Ticket sources. */
  selected?: SettingsPageId | LegacySettingsPageId;
  onSelect?: (page: SettingsPageId) => void;
}) {
  const { items, indicator } = useSettingsNavItems();
  const {
    query,
    setQuery,
    navOpen = false,
    setNavOpen = () => {},
    setup,
    setupRow,
  } = useSettingsState();
  const selected = navSectionOf(resolveSettingsPage(chosen));
  const mobile = useIsMobile();
  useEffect(() => {
    if (!mobile && navOpen) setNavOpen(false);
  }, [mobile, navOpen, setNavOpen]);
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
        <ArrowLeft size={16} aria-hidden="true" /> {`Back to ${origin}`}
      </button>
      <nav aria-label="Settings sections">
        {/* A field above the groups: typing shows the results in the page. */}
        <div className="settings-nav-search">
          <SearchInput
            id={SEARCH_INPUT_ID}
            data-responsive-navigation="settings-search"
            fill
            aria-label="Search settings"
            placeholder="Search settings"
            value={query}
            onValueChange={(value) => {
              setQuery(value);
              if (value.trim() && selected !== null) onSelect?.("search");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") setNavOpen(false);
            }}
          />
        </div>
        {setup && setupRow && (
          <div role="group" aria-label="Setup">
            <ul>
              <li>
                <button
                  type="button"
                  className="settings-nav-row settings-setup-row"
                  data-responsive-navigation="settings-section:setup"
                  aria-current={selected === "setup" ? "page" : undefined}
                  onClick={() => open("setup")}
                >
                  {selected === "setup" && <Glide id="settings-nav" />}
                  <ListChecks size={16} aria-hidden="true" />
                  <span className="settings-nav-label">
                    Set up ticketd
                  </span>{" "}
                  <span className="settings-setup-count">
                    <SetupRing done={setup.done} total={setup.steps.length} />
                    {`${setup.done} of ${setup.steps.length}`}
                  </span>
                </button>
              </li>
            </ul>
          </div>
        )}
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
