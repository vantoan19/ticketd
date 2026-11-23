import { useLayoutEffect, useRef, useState } from "react";
import { usePopupViewport } from "./usePopupViewport";
import { useLocation } from "react-router";
import { useSearchContext } from "fumadocs-ui/contexts/search";
import {
  Sidebar,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
  type SidebarProps,
} from "fumadocs-ui/layouts/docs/slots/sidebar";

function DocsSidebar(props: SidebarProps) {
  const { open, setOpen, mode } = useSidebar();
  const { open: searching } = useSearchContext();
  const { key } = useLocation();
  const previousPage = useRef(key);
  const [sheet, setSheet] = useState<HTMLDialogElement | null>(null);
  usePopupViewport(open ? sheet : null);
  useLayoutEffect(() => {
    // Picking the current article also closes its directory. A wider layout
    // and the search shortcut both give navigation to a different control.
    const visible =
      open && mode === "drawer" && !searching && key === previousPage.current;
    previousPage.current = key;
    if (open && !visible) {
      setOpen(false);
      if (mode === "full")
        document.getElementById("main-content")?.focus({ preventScroll: true });
    }
    if (!sheet) return;
    if (visible && !sheet.open) {
      sheet.showModal();
      // Older mobile Safari can leave focus on the document when the drawer
      // opens. Give keyboard and VoiceOver users a control inside the sheet.
      sheet
        .querySelector<HTMLButtonElement>(
          'button[aria-controls="nd-sidebar-mobile"]',
        )
        ?.focus({ preventScroll: true });
    }
    if (!visible && sheet.open) sheet.close();
  }, [key, mode, open, searching, setOpen, sheet]);
  if (
    mode !== "drawer" ||
    typeof HTMLDialogElement === "undefined" ||
    typeof HTMLDialogElement.prototype.showModal !== "function"
  )
    return <Sidebar {...props} />;
  return (
    <dialog
      ref={setSheet}
      className="doc-directory-dialog"
      aria-label="Documentation navigation"
      onClose={(event) => {
        if (!event.currentTarget.open) setOpen(false);
      }}
    >
      <Sidebar {...props} />
    </dialog>
  );
}

export const docsSidebar = {
  root: DocsSidebar,
  provider: SidebarProvider,
  trigger: SidebarTrigger,
  useSidebar,
};
