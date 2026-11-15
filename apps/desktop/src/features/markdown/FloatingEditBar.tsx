import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";

/** Editing controls float inside the visible pane, outside its scrolling prose. */
export function FloatingEditBar({
  status,
  controlsRef,
  onDone,
}: {
  status: ReactNode;
  controlsRef: (element: HTMLSpanElement | null) => void;
  onDone: () => void;
}) {
  const [pane, setPane] = useState<Element | null>(null);
  return (
    <>
      <span
        hidden
        ref={(element) => {
          if (element)
            setPane(
              element.closest(".ticket-detail, .context-view-wrapper") ??
                element.parentElement,
            );
        }}
      />
      {pane &&
        createPortal(
          <div className="floating-edit-position">
            <div
              role="group"
              aria-label="Edit controls"
              className="floating-edit-bar"
            >
              <span className="floating-edit-status">{status}</span>
              <span ref={controlsRef} className="floating-edit-tools" />
              <Button
                variant="outline"
                size="sm"
                aria-label="Done editing"
                onClick={onDone}
              >
                Done <Kbd aria-hidden="true">esc</Kbd>
              </Button>
            </div>
          </div>,
          pane,
        )}
    </>
  );
}
