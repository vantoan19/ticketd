import type { ComponentProps } from "react";
import { SearchInput } from "@/components/ui/search-input";

/** A library's local search occupies the existing title slot, never a new row. */
export function NavigatorSearch(props: ComponentProps<typeof SearchInput>) {
  return (
    <span data-slot="pane-search">
      <SearchInput autoFocus fill {...props} />
    </span>
  );
}
