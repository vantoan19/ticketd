import {
  useEffect,
  useState,
  type FocusEventHandler,
  type KeyboardEventHandler,
  type RefObject,
} from "react";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { focusNavigatorRow } from "@/lib/navigator";
import {
  ariaKeyShortcuts,
  matchesShortcut,
  type ShortcutId,
} from "@/lib/shortcuts";
import {
  loadPreferences,
  setPreference,
  usePreferences,
} from "@/lib/preferences";

export type GroupedListItemProps = {
  "data-grouped-list-item": "";
  "aria-keyshortcuts": string;
  tabIndex: 0 | -1;
  onFocus: FocusEventHandler<HTMLButtonElement>;
  onKeyDown: KeyboardEventHandler<HTMLButtonElement>;
};

/** Keep the folds for each list in the computer's interface preferences. */
export function useGroupFolds(list: "documentGroups" | "fileGroups") {
  const groups = usePreferences()[list];
  return {
    isOpen: (id: string, defaultOpen = true) =>
      Object.hasOwn(groups, id) ? (groups[id] ?? defaultOpen) : defaultOpen,
    setOpen: (id: string, open: boolean) =>
      setPreference(list, { ...loadPreferences()[list], [id]: open }),
  };
}

/** A group's read, scoped to the time it is open. Previously read rows stay while refreshing. */
export function usePagedGroup<T>({
  open,
  readPage,
  revision,
  loadAction,
  pageSize = 50,
  total,
}: {
  open: boolean;
  readPage: (offset: number) => Promise<T[]>;
  revision: number | string;
  loadAction: string;
  pageSize?: number;
  total?: number;
}) {
  const [rows, setRows] = useState<T[] | null>(null);
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [offset, setOffset] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) setFailure(null);
  }
  useEffect(() => {
    if (!open) return;
    let current = true;
    async function read() {
      try {
        // Re-read earlier pages as well: insertions or deletions can move rows between pages.
        const offsets = Array.from(
          { length: offset / pageSize + 1 },
          (_, i) => i * pageSize,
        );
        const result = (await Promise.all(offsets.map(readPage))).flat();
        if (current) {
          setRows(result);
          setFailure(null);
        }
      } catch (reason) {
        if (current) setFailure(describeFailure(reason, loadAction));
      }
    }
    void read();
    return () => {
      current = false;
    };
  }, [open, readPage, revision, loadAction, attempt, offset, pageSize]);
  const readCount = rows?.length ?? 0;
  const more =
    readCount < offset + pageSize
      ? 0
      : total === undefined
        ? pageSize
        : Math.min(pageSize, total - readCount);
  return {
    open,
    rows: open && !failure && rows ? rows : [],
    loaded: rows !== null,
    failure,
    retry: () => setAttempt((value) => value + 1),
    more,
    showMore: () => setOffset((value) => value + pageSize),
    resetPaging: () => setOffset(0),
  };
}

/**
 * Headers and rows share one Tab stop. Pass the visible IDs in DOM order.
 */
export function useGroupedListFocus(
  root: RefObject<HTMLElement | null>,
  visibleIds: readonly string[],
  moveShortcut: ShortcutId,
  selectedId?: string,
) {
  const [focused, setFocused] = useState<string | null>(null);
  const tabId =
    visibleIds.find((id) => id === focused) ??
    visibleIds.find((id) => id === selectedId) ??
    visibleIds[0];
  const shortcuts = ariaKeyShortcuts(moveShortcut);
  return {
    focusedId: focused,
    // A repeated row still participates in arrow navigation, with its Tab stop
    // on the original (e.g. the Pinned copy of a row that also appears in a group).
    item(id: string, duplicate = false): GroupedListItemProps {
      return {
        "data-grouped-list-item": "",
        "aria-keyshortcuts": shortcuts,
        tabIndex: !duplicate && id === tabId ? 0 : -1,
        onFocus: () => setFocused(id),
        onKeyDown: (event) => {
          if (!matchesShortcut(event, moveShortcut)) return;
          event.preventDefault();
          event.stopPropagation();
          focusNavigatorRow(
            Array.from(
              root.current?.querySelectorAll<HTMLButtonElement>(
                "[data-grouped-list-item]",
              ) ?? [],
            ),
            event.currentTarget,
            event.key,
          );
        },
      };
    },
  };
}
