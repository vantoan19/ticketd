import { useContext, useEffect, useState } from "react";
import { FileText, Pencil, Plus, X } from "lucide-react";
import { documents, type DocumentSummary } from "@/features/documents/api";
import { DocumentNavigation } from "@/features/documents/navigation";
import { Button } from "@/components/ui/button";
import { FailureAlert, FailureState } from "@/components/ui/failure-alert";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { Tooltip } from "@/components/ui/tooltip";
import { Item } from "@/components/ui/item";
import { IconButton } from "@/components/ui/icon-button";
import { useStatusLine } from "@/components/ui/use-status-line";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { type Ticket } from "@/lib/api/client";
import { DocumentPicker } from "./DocumentPicker";
import { RailSection } from "./RailSection";
import "./ticket-documents.css";

type DocumentLink = Awaited<ReturnType<typeof documents.links>>[0][number];

const sourceRank = (link: DocumentLink) =>
  link.explicit ? 0 : link.activity_id ? 2 : 1;

/** The Documents a ticket links to, with an Add action that links another by title. */
export function TicketDocuments({
  ticket,
  revision,
  refresh,
  onOpenUpdate,
}: {
  ticket: Ticket;
  revision: number;
  refresh: () => Promise<void>;
  /** Shows the update that mentions a Document. */
  onOpenUpdate?: (activityId: string) => void;
}) {
  const openDocument = useContext(DocumentNavigation);
  const [links, setLinks] = useState<DocumentLink[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<FailureDescription | null>(null);
  // A failed read says so in place of the list, with Retry; it never reads as empty.
  const [loadFailure, setLoadFailure] = useState<FailureDescription | null>(
    null,
  );
  const statusLine = useStatusLine();
  // Trashing or restoring a Document elsewhere does not change this ticket, so
  // coming back to the window checks again as well as a new workspace revision.
  const [visits, setVisits] = useState(0);
  useEffect(() => {
    const again = () => setVisits((value) => value + 1);
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, []);
  useEffect(() => {
    let current = true;
    void documents
      .links(ticket.id)
      .then(([outgoing]) => {
        if (!current) return;
        // One row per Document, by its strongest source: attached, then
        // mentioned in the description, then mentioned in an update.
        const byDocument = new Map<string, DocumentLink>();
        for (const link of outgoing) {
          if (link.target_kind !== "document") continue;
          const known = byDocument.get(link.target_id);
          if (!known || sourceRank(link) < sourceRank(known))
            byDocument.set(link.target_id, link);
        }
        // Attached Documents list first, like the CLI's context.
        setLinks(
          [...byDocument.values()].sort(
            (a, b) => sourceRank(a) - sourceRank(b),
          ),
        );
        setLoadFailure(null);
      })
      .catch((reason: unknown) => {
        if (current) setLoadFailure(describeFailure(reason, "load Documents"));
      });
    return () => {
      current = false;
    };
  }, [ticket.id, ticket.body, revision, visits]);
  async function change(id: string, present: boolean) {
    setError(null);
    try {
      await documents.setTicketDocument(ticket.reference, id, present);
      setVisits((value) => value + 1);
      await refresh();
      return true;
    } catch (reason) {
      setError(
        describeFailure(
          reason,
          present ? "attach the Document" : "unlink the Document",
        ),
      );
      return false;
    }
  }
  /** Unlinks at once; the pane's status line offers Undo (P7). */
  async function unlink(link: DocumentLink) {
    if (!(await change(link.target_id, false))) return;
    statusLine.show({
      message: `Unlinked ${link.target_label}`,
      undo: async () => {
        await documents.setTicketDocument(
          ticket.reference,
          link.target_id,
          true,
        );
        setVisits((value) => value + 1);
        await refresh();
      },
    });
  }
  async function add(picked: DocumentSummary) {
    setOpen(false);
    await change(picked.id, true);
  }
  function editDescription(documentId: string) {
    window.dispatchEvent(
      new CustomEvent("ticketd:edit-description", {
        detail: { reference: ticket.reference, documentId },
      }),
    );
  }
  return (
    <RailSection label="Documents">
      <div className="ticket-documents">
        <ul>
          {links.map((link) => (
            <Item key={link.target_id} asChild>
              <li>
                <button
                  type="button"
                  className="ticket-documents-item"
                  onClick={() => openDocument?.(link.target_id)}
                >
                  <FileText aria-hidden="true" />
                  <Tooltip content={link.target_label} overflowOnly>
                    <span className="ticket-documents-title">
                      {link.target_label}
                    </span>
                  </Tooltip>
                  {link.target_trashed && (
                    <span className="ticket-documents-badge">Trash</span>
                  )}
                </button>
                {link.explicit ? (
                  <Tooltip content="Unlink">
                    <button
                      type="button"
                      className="ticket-documents-unlink"
                      aria-label={`Unlink ${link.target_label}`}
                      onClick={() => void unlink(link)}
                    >
                      <X aria-hidden="true" />
                    </button>
                  </Tooltip>
                ) : link.activity_id ? null : (
                  <IconButton
                    size="icon-xs"
                    className="ticket-documents-edit"
                    label={`Edit description to remove ${link.target_label}`}
                    onClick={() => editDescription(link.target_id)}
                  >
                    <Pencil aria-hidden="true" />
                  </IconButton>
                )}
                {!link.explicit && link.activity_id && (
                  <Tooltip content="Open the update that mentions this Document">
                    <button
                      type="button"
                      className="ticket-documents-source"
                      aria-description="Opens the update that mentions this Document"
                      onClick={() => onOpenUpdate?.(link.activity_id!)}
                    >
                      From update
                    </button>
                  </Tooltip>
                )}
              </li>
            </Item>
          ))}
        </ul>
        {loadFailure && (
          <FailureState
            size="inline"
            failure={loadFailure}
            onRetry={() => setVisits((value) => value + 1)}
          />
        )}
        {error && <FailureAlert size="compact" failure={error} />}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="ticket-documents-add"
              aria-label="Add Document"
            >
              <Plus aria-hidden="true" />
              Attach Document
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="ticket-documents-popover">
            <DocumentPicker
              includeSupport
              exclude={links.map((link) => link.target_id)}
              onPick={(picked) => void add(picked)}
            />
          </PopoverContent>
        </Popover>
      </div>
    </RailSection>
  );
}
