import { Columns3, List, SlidersHorizontal } from "lucide-react";
import { PaneHeaderButton } from "@/components/ui/list-header";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { setPreference, usePreferences } from "@/lib/preferences";
import "./display-menu.css";

/**
 * How the ticket list looks: Layout (List or Board) and Rows (One line or
 * Detailed). Both choices are remembered on this computer like every preference.
 */
export function DisplayMenu({
  onError,
  rowsOnly = false,
}: {
  onError: (message: string) => void;
  /** Plans and Trash take their layout elsewhere; only Rows applies there. */
  rowsOnly?: boolean;
}) {
  const { ticketLayout, ticketRows } = usePreferences();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <PaneHeaderButton icon={<SlidersHorizontal />} label="Display" />
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="Display">
        <PopoverTitle>Display</PopoverTitle>
        <div className="display-menu">
          {!rowsOnly && (
            <>
              <span id="display-layout">Layout</span>
              <SegmentedControl
                compact
                aria-labelledby="display-layout"
                value={ticketLayout}
                onValueChange={(value) => {
                  if (!setPreference("ticketLayout", value))
                    onError(
                      "Couldn't remember the ticket layout. This window can't store preferences right now.",
                    );
                }}
                options={[
                  { value: "list", label: "List", icon: <List /> },
                  { value: "board", label: "Board", icon: <Columns3 /> },
                ]}
              />
            </>
          )}
          <span id="display-rows">Rows</span>
          <SegmentedControl
            compact
            aria-labelledby="display-rows"
            value={ticketRows}
            onValueChange={(value) => {
              if (!setPreference("ticketRows", value))
                onError(
                  "Couldn't remember the row style. This window can't store preferences right now.",
                );
            }}
            options={[
              { value: "simple", label: "One line" },
              { value: "detailed", label: "Detailed" },
            ]}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
