import { Columns3, List, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
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
 * How the ticket list looks: Layout (List or Board) and Rows (Detailed or
 * Simple). Both choices are remembered on this computer like every preference.
 */
export function DisplayMenu({
  onError,
}: {
  onError: (message: string) => void;
}) {
  const { ticketLayout, ticketRows } = usePreferences();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm">
          <SlidersHorizontal data-icon="inline-start" />
          Display
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="Display">
        <PopoverTitle>Display</PopoverTitle>
        <div className="display-menu">
          <span id="display-layout">Layout</span>
          <SegmentedControl
            compact
            aria-labelledby="display-layout"
            value={ticketLayout}
            onValueChange={(value) => {
              if (!setPreference("ticketLayout", value))
                onError(
                  "Could not remember ticket layout. Check local storage and try again.",
                );
            }}
            options={[
              { value: "list", label: "List", icon: <List /> },
              { value: "board", label: "Board", icon: <Columns3 /> },
            ]}
          />
          <span id="display-rows">Rows</span>
          <SegmentedControl
            compact
            aria-labelledby="display-rows"
            value={ticketRows}
            onValueChange={(value) => {
              if (!setPreference("ticketRows", value))
                onError(
                  "Could not remember row style. Check local storage and try again.",
                );
            }}
            options={[
              { value: "detailed", label: "Detailed" },
              { value: "simple", label: "Simple" },
            ]}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
