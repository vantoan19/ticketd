import { useCallback, useState } from "react";

/** A conditional owner stays mounted until Radix finishes its content exit. */
export function useDialogPresence(
  onExitComplete: () => void,
  initiallyOpen = true,
) {
  const [open, setOpen] = useState(initiallyOpen);
  const close = useCallback(() => setOpen(false), []);
  return {
    dialog: { open, onOpenChange: setOpen, onExitComplete },
    close,
  };
}
