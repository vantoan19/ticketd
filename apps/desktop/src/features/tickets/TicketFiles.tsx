import { useId, useMemo, useState, type CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { FailureAlert, FailureState } from "@/components/ui/failure-alert";
import { SectionHeader } from "@/components/ui/section-header";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import type { Attachment } from "@/lib/api/attachments";
import { useOpenTicket } from "./open-ticket";
import { DocumentPicker } from "./DocumentPicker";
import { AttachmentDialogs } from "./TicketAttachments";
import { useAttachmentItems } from "./use-attachment-items";
import { useTicketAttachments } from "./use-ticket-attachments";
import { DocumentRow } from "./TicketDocuments";
import { useTicketDocuments } from "./use-ticket-documents";
import "./ticket-files.css";

const cardWidth = 140;

export type FileAddRequest = { kind: "file" | "document"; key: number };

/** A compact preview of a ticket's Documents and attachments. */
export function TicketFiles({
  onOpenUpdate,
  expanded = false,
  hideEmpty = false,
  addRequest,
  addTrigger,
}: {
  /** Shows the update that mentions a Document. */
  onOpenUpdate?: (activityId: string) => void;
  expanded?: boolean;
  hideEmpty?: boolean;
  addRequest?: FileAddRequest | null;
  addTrigger?: HTMLElement | null;
}) {
  const { record: ticket } = useOpenTicket();
  const files = useTicketAttachments();
  const docs = useTicketDocuments();
  const [picker, setPicker] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [selected, setSelected] = useState<Attachment | null>(null);
  const [all, setAll] = useState(false);
  const [lastAddRequest, setLastAddRequest] = useState(addRequest);
  const id = useId();
  const gridId = `${id}-grid`;
  const anchor = useMemo(() => ({ current: addTrigger ?? null }), [addTrigger]);
  const readOnly = ticket.trashed;
  if (lastAddRequest !== addRequest) {
    setLastAddRequest(addRequest);
    if (!readOnly && addRequest) {
      setPicker(addRequest.kind === "file");
      setChoosing(addRequest.kind === "document");
    }
  }
  const loaded = files.found !== null && docs.links !== null;
  const total = (files.found?.length ?? 0) + (docs.links?.length ?? 0);
  const failed = files.loadFailure ?? docs.loadFailure;
  const hidden =
    loaded &&
    total === 0 &&
    !failed &&
    !docs.error &&
    !files.error &&
    (readOnly || hideEmpty);
  const limit = expanded ? 4 : 3;
  const fileItems = useAttachmentItems(
    files.found ?? [],
    (file) => {
      files.setError(null);
      setSelected(file);
    },
    cardWidth,
  );
  const cards = [
    ...(docs.links ?? []).map((link) => (
      <DocumentRow
        key={link.target_id}
        link={link}
        readOnly={readOnly}
        ticketReference={ticket.reference}
        onUnlink={() => void docs.unlink(link)}
        onOpenUpdate={onOpenUpdate}
        cardWidth={cardWidth}
      />
    )),
    ...fileItems,
  ];
  const hasMore = total > limit;
  const showAll = all && hasMore;
  return (
    <>
      {!hidden && (
        <section className="ticket-files" aria-labelledby={id}>
          <SectionHeader
            title="Files"
            titleId={id}
            level={2}
            count={loaded ? total || undefined : undefined}
            focusTarget
            actions={
              hasMore && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={showAll}
                  aria-controls={gridId}
                  onClick={() => setAll(!showAll)}
                >
                  {showAll ? "Show less" : `Show all ${total}`}
                </Button>
              )
            }
          />
          {!loaded && !failed && <Skeleton className="h-8" />}
          {failed && (
            <FailureState
              size="inline"
              failure={failed}
              onRetry={() => {
                files.retry();
                docs.retry();
              }}
            />
          )}
          {total > 0 && (
            <ul
              id={gridId}
              className="file-grid ticket-files-grid"
              aria-label="Files"
              data-show-all={showAll || undefined}
              style={
                { "--ticket-file-width": `${cardWidth}px` } as CSSProperties
              }
            >
              {showAll ? cards : cards.slice(0, limit)}
            </ul>
          )}
          {docs.error && <FailureAlert size="compact" failure={docs.error} />}
          {files.error && !selected && (
            <FailureAlert size="compact" failure={files.error} />
          )}
        </section>
      )}
      {addTrigger && !readOnly && (
        <Popover open={choosing} onOpenChange={setChoosing}>
          <PopoverAnchor virtualRef={anchor} />
          <PopoverContent
            align="end"
            variant="list"
            aria-label="Attach a Document"
            onCloseAutoFocus={(event) => {
              if (!addTrigger.isConnected) return;
              event.preventDefault();
              addTrigger.focus({ preventScroll: true });
            }}
          >
            <DocumentPicker
              includeSupport
              exclude={(docs.links ?? []).map((link) => link.target_id)}
              onPick={(picked) => {
                setChoosing(false);
                void docs.add(picked);
              }}
            />
          </PopoverContent>
        </Popover>
      )}
      <AttachmentDialogs
        ticket={ticket}
        state={files}
        picker={picker && !readOnly}
        onPickerChange={setPicker}
        selected={selected}
        onSelected={setSelected}
        fallbackFocus={() => document.getElementById(id) ?? addTrigger ?? null}
      />
    </>
  );
}
