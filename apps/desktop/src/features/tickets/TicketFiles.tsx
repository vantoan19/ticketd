import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { FileText, Paperclip, Plus } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { FailureAlert, FailureState } from "@/components/ui/failure-alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import type { Attachment } from "@/lib/api/attachments";
import { useOpenTicket } from "./open-ticket";
import { DocumentPicker } from "./DocumentPicker";
import { RailRow, RailSection } from "./RailSection";
import { FileGrid } from "@/features/attachments/FileCard";
import { AttachmentDialogs, useAttachmentItems } from "./TicketAttachments";
import { useTicketAttachments } from "./use-ticket-attachments";
import { DocumentRow } from "./TicketDocuments";
import { useTicketDocuments } from "./use-ticket-documents";

/**
 * The rail's Files (S12): the ticket's Documents and attached files in one
 * section, one row each, with one Attach menu (File… / Document…). The menu
 * is the "+" at the label's end; an empty section is its label and one
 * "Attach…" row. A ticket in Trash shows its files read-only, and nothing
 * when it has none.
 */
export function TicketFiles({
  onOpenUpdate,
  emptyTarget,
}: {
  emptyTarget?: HTMLElement | null;
  /** Shows the update that mentions a Document. */
  onOpenUpdate?: (activityId: string) => void;
}) {
  const { record: ticket } = useOpenTicket();
  const files = useTicketAttachments();
  const docs = useTicketDocuments();
  const [picker, setPicker] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [selected, setSelected] = useState<Attachment | null>(null);
  const section = useRef<HTMLDivElement>(null);
  // Choosing "Document…" closes the menu and opens the picker in its place;
  // the menu must not hand focus back to its trigger on the way out.
  const toPicker = useRef(false);
  const readOnly = ticket.trashed;
  const loaded = files.found !== null && docs.links !== null;
  const empty = loaded && !files.found?.length && !docs.links?.length;
  const failed = files.loadFailure ?? docs.loadFailure;
  const fileItems = useAttachmentItems(files.found ?? [], (file) => {
    files.setError(null);
    setSelected(file);
  });
  if (readOnly && empty) return null;
  const menu = (trigger: ReactNode) => (
    <Popover open={choosing} onOpenChange={setChoosing}>
      <DropdownMenu>
        <PopoverAnchor asChild>
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        </PopoverAnchor>
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(event) => {
            if (toPicker.current) {
              toPicker.current = false;
              event.preventDefault();
            }
          }}
        >
          <DropdownMenuItem onSelect={() => setPicker(true)}>
            <Paperclip aria-hidden="true" />
            File…
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              toPicker.current = true;
              setChoosing(true);
            }}
          >
            <FileText aria-hidden="true" />
            Document…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <PopoverContent align="end" variant="list" aria-label="Attach a Document">
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
  );
  const actions =
    !readOnly && !empty
      ? menu(
          <IconButton label="Attach" tooltipSide="top">
            <Plus aria-hidden="true" />
          </IconButton>,
        )
      : undefined;
  return (
    <>
      {empty &&
        !readOnly &&
        emptyTarget &&
        createPortal(
          menu(
            <Button variant="ghost" size="sm">
              <Plus aria-hidden="true" />
              File
            </Button>,
          ),
          emptyTarget,
        )}
      <div ref={section} hidden={empty && Boolean(emptyTarget)}>
        <RailSection
          label="Files"
          count={
            loaded
              ? (files.found?.length ?? 0) + (docs.links?.length ?? 0)
              : undefined
          }
          {...(actions && { actions })}
        >
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
          {!empty && (
            <FileGrid label="Files">
              {(docs.links ?? []).map((link) => (
                <DocumentRow
                  key={link.target_id}
                  link={link}
                  readOnly={readOnly}
                  ticketReference={ticket.reference}
                  onUnlink={() => void docs.unlink(link)}
                  onOpenUpdate={onOpenUpdate}
                />
              ))}
              {fileItems}
            </FileGrid>
          )}
          {empty &&
            !emptyTarget &&
            !readOnly &&
            menu(
              <RailRow icon={<Plus aria-hidden="true" />} muted>
                Attach…
              </RailRow>,
            )}
          {docs.error && <FailureAlert size="compact" failure={docs.error} />}
          {files.error && !selected && (
            <FailureAlert size="compact" failure={files.error} />
          )}
          <AttachmentDialogs
            ticket={ticket}
            state={files}
            picker={picker}
            onPickerChange={setPicker}
            selected={selected}
            onSelected={setSelected}
            fallbackFocus={() => {
              // The file that opened the viewer was detached: land on the heading.
              const heading = section.current?.querySelector<HTMLElement>("h3");
              heading?.setAttribute("tabindex", "-1");
              return heading ?? null;
            }}
          />
        </RailSection>
      </div>
    </>
  );
}
