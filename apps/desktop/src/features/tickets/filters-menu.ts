import { useState } from "react";

/** One filter dimension, as the menu and the chip row name it. */
export type Dimension = "Status" | "Availability" | "Plan" | "Tags" | "Parent";

export type FiltersMenuState = {
  open: boolean;
  setOpen: (open: boolean) => void;
  sub: Dimension | null;
  setSub: (sub: Dimension | null) => void;
};

/** Open state for one list's Filters menu and its chips. */
export function useFiltersMenu(): FiltersMenuState {
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<Dimension | null>(null);
  return {
    open,
    setOpen: (next) => {
      setOpen(next);
      if (!next) setSub(null);
    },
    sub,
    setSub,
  };
}
