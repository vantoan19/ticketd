import { ShellNoticeSlot } from "@/components/ui/list-header";
import { Fragment, useEffect, useRef, type ReactNode } from "react";
import { ChevronDown, ChevronLeft, Menu, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconTile } from "@/components/ui/icon-tile";
import { StatusDot } from "@/components/ui/status-dot";
import { useIsMobile } from "@/hooks/use-mobile";
import { useNeeds } from "@/features/settings/use-needs";
import { useSettingsState } from "@/features/settings/use-settings-state";
import "@/features/settings/layout/settings-layout.css";

/**
 * One Settings page: the sticky panel bar with its breadcrumb, then a centred
 * column with the page header. The title is the page's `h1` and takes focus
 * when the page opens. Pages put `SettingsSection`s in the column.
 */
export function SettingsPage({
  group,
  label,
  icon: Icon,
  iconContent,
  title = label,
  lede,
  ledeNote,
  drillIn,
  endSlot,
  titleAccessory,
  footer,
  hidden = false,
  focusTitle = true,
  wordmark = false,
  header = true,
  children,
}: {
  /** Breadcrumb group, muted: "Workspace". */
  group: string;
  /** Breadcrumb page name, in the foreground color. */
  label: string;
  icon: LucideIcon;
  iconContent?: ReactNode;
  /** The `h1`; the label unless the page names itself differently. */
  title?: ReactNode;
  /**
   * One sentence under the title, at most 560px wide. A string may mark a
   * command with backticks.
   */
  lede?: ReactNode;
  /** About: a second quiet line under the lede, such as the promises. */
  ledeNote?: string;
  /**
   * Set when this page opened in place from `parent`'s list (`SettingsDrillIn`
   * fills it in): the panel bar gets a back control and the breadcrumb a
   * third step that returns.
   */
  drillIn?: { parent: string; onBack: () => void };
  /** The end of the panel bar: a source's save state. */
  endSlot?: ReactNode;
  /** Sits beside the title, such as Chat's Experimental badge. */
  titleAccessory?: ReactNode;
  /** Sticks to the bottom of the panel, under the page: a source's save bar. */
  footer?: ReactNode;
  /** Keeps the page mounted but out of sight (a source's draft and preview). */
  hidden?: boolean;
  /** Pages with a better first control, such as Search, take focus themselves. */
  focusTitle?: boolean;
  /** About: the title is the product wordmark (32/40) and the header has no icon tile. */
  wordmark?: boolean;
  /** Search has no page header: its labelled input opens the page. */
  header?: boolean;
  children: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  // Whether the person's last focus or press was on this page.
  const inside = useRef(false);
  const { navOpen = false, setNavOpen } = useSettingsState();
  // The trigger carries the dot while any page does.
  const setup = useNeeds().length > 0;
  const mobile = useIsMobile();
  // Opening a page replaces what held focus; land on its title.
  useEffect(() => {
    if (!hidden && focusTitle) heading.current?.focus({ preventScroll: true });
  }, [hidden, focusTitle]);
  // An in-place action (Install, Continue, Allow) can remove the very control
  // that held focus, which drops it on the body: the next Tab would start at the
  // top of the window. Land on what replaced it: the page's marked step heading,
  // else its title.
  useEffect(() => {
    const root = shell.current;
    if (hidden || !focusTitle || !root) return;
    const track = (event: FocusEvent) => {
      inside.current =
        event.target instanceof Node && root.contains(event.target);
    };
    // A click on empty space puts focus nowhere on purpose; a click on a
    // control that is already focused fires no focus event; a removed control
    // reports nothing at all, which is the case to repair.
    const press = (event: PointerEvent) => {
      const control =
        event.target instanceof Element
          ? event.target.closest(
              'button, a[href], input, select, textarea, summary, [role="button"], [tabindex]',
            )
          : null;
      inside.current = !!control && root.contains(control);
    };
    const repair = () => {
      const active = document.activeElement;
      if (!inside.current || (active && active !== document.body)) return;
      const target =
        root.querySelector<HTMLElement>("[data-focus-target]") ??
        heading.current;
      target?.focus({ preventScroll: true });
    };
    const observer = new MutationObserver(repair);
    // A dialog's portal is a child of the body: its removal is the moment the
    // confirm button's focus is lost, when the page may already have changed.
    // The dialog returns focus to its opener a tick later; repair only what
    // that leaves on the body.
    let later: ReturnType<typeof setTimeout> | undefined;
    const portals = new MutationObserver(() => {
      clearTimeout(later);
      later = setTimeout(repair, 50);
    });
    // Capture, so these run before the shell's own handlers below.
    document.addEventListener("focusin", track, true);
    document.addEventListener("pointerdown", press, true);
    observer.observe(root, { childList: true, subtree: true });
    portals.observe(document.body, { childList: true });
    return () => {
      portals.disconnect();
      clearTimeout(later);
      document.removeEventListener("focusin", track, true);
      document.removeEventListener("pointerdown", press, true);
      observer.disconnect();
    };
  }, [hidden, focusTitle]);
  const claimPortaled = (event: React.SyntheticEvent) => {
    if (event.target instanceof Node && !shell.current?.contains(event.target))
      inside.current = true;
  };
  return (
    <div
      className="settings-shell"
      hidden={hidden}
      ref={shell}
      // A dialog the page opens (a confirm) renders in a portal, outside the
      // shell's DOM but inside its React tree: focus or a press there still
      // belongs to the page, so closing the dialog can repair the focus it
      // drops. A dialog from elsewhere (the palette) never reaches these.
      onFocus={claimPortaled}
      onPointerDown={claimPortaled}
    >
      <div className="settings-panel-bar">
        {drillIn && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="-ml-2"
            aria-label={`Back to ${drillIn.parent}`}
            onClick={drillIn.onBack}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
        )}
        {mobile ? (
          // The nav is a sheet here: the breadcrumb becomes its trigger.
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2 min-w-0"
            data-responsive-navigation="settings-navigation"
            aria-haspopup="dialog"
            aria-expanded={navOpen}
            aria-label={`${label}, Settings sections${setup ? ", a section needs setup" : ""}`}
            onClick={() => setNavOpen?.(true)}
          >
            <Menu aria-hidden="true" />
            {label}
            <ChevronDown aria-hidden="true" />
            {setup && <StatusDot tone="attention" />}
          </Button>
        ) : (
          <nav aria-label="Breadcrumb">
            <ol>
              <li>{group}</li>
              {drillIn && (
                <li>
                  <button
                    type="button"
                    className="settings-crumb-link"
                    onClick={drillIn.onBack}
                  >
                    {drillIn.parent}
                  </button>
                </li>
              )}
              <li aria-current="page">{label}</li>
            </ol>
          </nav>
        )}
        <div className="settings-panel-bar-end">
          <ShellNoticeSlot />
          {endSlot}
        </div>
      </div>
      <div className="settings-page-column">
        {header ? (
          <header
            className="settings-page-header"
            data-wordmark={wordmark || undefined}
          >
            {!wordmark && <IconTile>{iconContent ?? <Icon />}</IconTile>}
            <div className="settings-page-heading">
              <div className="settings-page-title-line">
                <h1 ref={heading} tabIndex={-1}>
                  {title}
                </h1>
                {titleAccessory}
              </div>
              {lede && (
                <p className="settings-page-lede">
                  {typeof lede === "string" ? <JobLine text={lede} /> : lede}
                </p>
              )}
              {ledeNote && <p className="settings-page-lede">{ledeNote}</p>}
            </div>
          </header>
        ) : null}
        {children}
      </div>
      {footer}
    </div>
  );
}

/** A job line as text, with a backticked command set in the code font. */
function JobLine({ text }: { text: string }) {
  return text.split("`").map((part, index) =>
    index % 2 === 1 ? (
      <code key={index} className="font-mono">
        {part}
      </code>
    ) : (
      <Fragment key={index}>{part}</Fragment>
    ),
  );
}
