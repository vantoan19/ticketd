import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
} from "fumadocs-ui/components/dialog/search";
import { experimental_useSearch as useSearch } from "fumadocs-core/search/client";
import { X } from "lucide-react";
import { siteUrl } from "../links";
import { usePopupViewport } from "./usePopupViewport";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

// Fumadocs caches the index promise by URL for this page session, including a
// failed request. Reuse a successful retry when the dialog next mounts.
let latestAttempt = 0;

function labelSearchBoundaries(popup: HTMLDivElement | null) {
  if (!popup) return;
  // In WebKit, Base UI exposes the focus loop as two buttons to VoiceOver.
  // Keep their keyboard behaviour and describe where each moves the reader.
  for (const [guard, label] of [
    [popup.previousElementSibling, "Move to the last search control"],
    [popup.nextElementSibling, "Move to the first search control"],
  ] as const) {
    if (guard?.hasAttribute("data-base-ui-focus-guard"))
      guard.setAttribute("aria-label", label);
  }
}

export default function StaticSearchDialog(props: SharedProps) {
  const [attempt, setAttempt] = useState(latestAttempt);
  const find = useCallback(
    async (query: string) => {
      // An article can be read without downloading the local search engine.
      const { staticClient } =
        await import("fumadocs-core/search/client/orama-static");
      const from =
        siteUrl("/api/search") + (attempt ? "?retry=" + attempt : "");
      return staticClient({ from }).search(query);
    },
    [attempt],
  );
  const search = useSearch(find);
  const input = useRef<HTMLInputElement>(null);
  const selected = useRef(false);
  const [popup, setPopup] = useState<HTMLDivElement | null>(null);
  const { open, onOpenChange } = props;
  useEffect(() => {
    if (!open || !/Android/i.test(navigator.userAgent)) return;
    // Back first dismisses the Android keyboard. The next press should close
    // search and return focus to its trigger, keeping the current article.
    const Watcher = (
      window as Window & {
        CloseWatcher?: new () => EventTarget & { destroy(): void };
      }
    ).CloseWatcher;
    if (!Watcher) return;
    const watcher = new Watcher();
    watcher.addEventListener("close", () => onOpenChange(false));
    return () => watcher.destroy();
  }, [open, onOpenChange]);
  useLayoutEffect(() => {
    labelSearchBoundaries(popup);
  }, [popup]);
  usePopupViewport(popup);
  return (
    <SearchDialog
      {...search}
      {...props}
      onSelect={() => {
        selected.current = true;
      }}
    >
      <SearchDialogOverlay />
      <SearchDialogContent
        ref={setPopup}
        finalFocus={() => {
          const restore = !selected.current;
          selected.current = false;
          return restore;
        }}
      >
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput ref={input} />
          <SearchDialogClose
            className="search-dismiss"
            aria-label="Close search"
            aria-keyshortcuts="Escape"
          >
            <span aria-hidden="true">Esc</span>
            <X size={17} aria-hidden="true" />
          </SearchDialogClose>
        </SearchDialogHeader>
        <SearchDialogList />
        {search.error != null && (
          <button
            type="button"
            className="search-retry"
            disabled={search.isLoading}
            onClick={() => {
              setAttempt(++latestAttempt);
              input.current?.focus();
            }}
          >
            Try again
          </button>
        )}
      </SearchDialogContent>
    </SearchDialog>
  );
}
