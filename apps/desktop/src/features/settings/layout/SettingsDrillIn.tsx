import { useEffect, type ComponentProps } from "react";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";
import {
  sectionMeta,
  type SettingsSectionId,
} from "@/features/settings/settings-sections";

/** True while a dialog, menu or list is open: Escape belongs to it, not to the page. */
function layerOpen() {
  return document.querySelector(
    '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
  );
}

/**
 * One thing opened in place from a Settings page's list: a connection from
 * Ticket sources, an agent from Agents. It is the page's own view, not a
 * deeper page: the sidebar keeps `parent` selected and gains no entry, the
 * panel bar shows a back control and a breadcrumb (group / parent / this),
 * and Back or Escape return to the list.
 *
 * Pass what a `SettingsPage` takes (`label`, `icon`, `lede`, children…); the
 * group and the parent's name come from `parent`.
 */
export function SettingsDrillIn({
  parent,
  onBack,
  hidden = false,
  ...page
}: {
  /** The page whose list this opened from. */
  parent: SettingsSectionId;
  /** Returns to the parent's list. */
  onBack: () => void;
} & Omit<ComponentProps<typeof SettingsPage>, "group" | "drillIn">) {
  const { group, label: parentLabel } = sectionMeta(parent);
  useEffect(() => {
    if (hidden) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || layerOpen())
        return;
      event.preventDefault();
      onBack();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hidden, onBack]);
  return (
    <SettingsPage
      {...page}
      group={group}
      hidden={hidden}
      drillIn={{ parent: parentLabel, onBack }}
    />
  );
}
