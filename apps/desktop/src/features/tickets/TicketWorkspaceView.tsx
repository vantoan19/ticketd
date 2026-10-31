import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDefaultLayout } from "react-resizable-panels";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { cn } from "cn";
import { TicketDetailPane } from "@/features/tickets/TicketDetailPane";
import { TicketListPane } from "@/features/tickets/TicketListPane";
import type { BulkEdit } from "@/features/tickets/useBulkEdit";
import type { TicketWorkspace } from "@/features/tickets/useTicketWorkspace";

const NARROW_QUERY = "(max-width: 1063px)";

/**
 * Arranges the list and detail panes and the split, expanded, and narrow
 * modes between them, including where focus lands when the mode changes.
 */
export function TicketWorkspaceView({
  workspace,
  bulk,
  hidden,
  inboxTarget,
  onCreate,
}: {
  workspace: TicketWorkspace;
  bulk: BulkEdit;
  hidden: boolean;
  inboxTarget: { reference: string; id: string; key: number } | null;
  onCreate: (trigger: HTMLButtonElement) => void;
}) {
  const { selected, setSelected } = workspace;
  const [expanded, setExpanded] = useState(false);
  const [narrowDetail, setNarrowDetail] = useState(false);
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "ticketd.workspace",
  });
  const listRef = useRef<HTMLElement>(null);
  const focusPane = useRef<"detail" | "list" | null>(null);
  useLayoutEffect(() => {
    if (focusPane.current === "detail")
      document.getElementById("detail-heading")?.focus();
    if (focusPane.current === "list") {
      const target = listRef.current?.querySelector<HTMLButtonElement>(
        '[aria-pressed="true"]',
      );
      (target ?? document.getElementById("tickets-heading"))?.focus();
    }
    focusPane.current = null;
  });
  useEffect(() => {
    const media = window.matchMedia(NARROW_QUERY);
    const showSelected = (event: MediaQueryListEvent) => {
      if (event.matches && selected) setNarrowDetail(true);
    };
    media.addEventListener("change", showSelected);
    return () => media.removeEventListener("change", showSelected);
  }, [selected]);
  const [previousSelection, setPreviousSelection] = useState(selected);
  if (previousSelection !== selected) {
    setPreviousSelection(selected);
    setNarrowDetail(selected !== null);
    if (!selected) setExpanded(false);
  }
  return (
    <ResizablePanelGroup
      orientation="horizontal"
      className={cn(
        "ticket-workspace",
        expanded && "expanded",
        narrowDetail && "narrow-detail",
      )}
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
      hidden={hidden}
    >
      <ResizablePanel
        id="list"
        minSize={360}
        defaultSize={480}
        className="list-panel"
      >
        <TicketListPane
          workspace={workspace}
          bulk={bulk}
          listRef={listRef}
          onCreate={onCreate}
          onOpen={(reference) => {
            setSelected(reference);
            setNarrowDetail(true);
            if (window.matchMedia(NARROW_QUERY).matches)
              focusPane.current = "detail";
          }}
        />
      </ResizablePanel>
      <ResizableHandle
        className="split-handle"
        aria-label="Resize ticket list"
      />
      <ResizablePanel id="detail" minSize={480} className="detail-panel">
        <TicketDetailPane
          workspace={workspace}
          expanded={expanded}
          inboxTarget={inboxTarget}
          onExpand={() => {
            setExpanded(true);
            focusPane.current = "detail";
          }}
          onReturn={() => {
            setExpanded(false);
            setNarrowDetail(false);
            focusPane.current = "list";
          }}
          onSelect={(value) => {
            if (value === null) focusPane.current = "list";
            setSelected(value);
          }}
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
