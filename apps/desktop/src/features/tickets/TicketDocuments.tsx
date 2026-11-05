import { useContext, useEffect, useState } from "react";
import { FileText, Pencil, Plus, X } from "lucide-react";
import { documents, type DocumentSummary } from "@/features/documents/api";
import { DocumentNavigation } from "@/features/documents/navigation";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
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

/** The Documents a ticket links to, with an Add action that links another by title. */
export function TicketDocuments({
  ticket,
  revision,
  refresh,
}: {
  ticket: Ticket;
  revision: number;
  refresh: () => Promise<void>;
}) {
  const openDocument = useContext(DocumentNavigation);
  const [links, setLinks] = useState<DocumentLink[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
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
        // One row per Document; it is explicit if any of its links is.
        const byDocument = new Map<string, DocumentLink>();
        for (const link of outgoing) {
          if (link.target_kind !== "document") continue;
          const known = byDocument.get(link.target_id);
          if (!known || (link.explicit && !known.explicit))
            byDocument.set(link.target_id, link);
        }
        setLinks([...byDocument.values()]);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [ticket.id, ticket.body, revision, visits]);
  async function change(id: string, present: boolean) {
    setError("");
    try {
      await documents.setTicketDocument(ticket.reference, id, present);
      setVisits((value) => value + 1);
      await refresh();
    } catch (reason) {
      setError(String(reason));
    }
  }
  async function add(picked: DocumentSummary) {
    setOpen(false);
    // Attaching Activity details is a decision to keep them as a Document.
    if (picked.origin_ticket) {
      try {
        await documents.keep(picked.id, crypto.randomUUID());
      } catch (reason) {
        setError(String(reason));
        return;
      }
    }
    await change(picked.id, true);
  }
  function editDescription() {
    window.dispatchEvent(
      new CustomEvent("ticketd:edit-description", { detail: ticket.reference }),
    );
  }
  return (
    <RailSection label="Documents">
      <div className="ticket-documents">
        <ul>
          {links.map((link) => (
            <li key={link.target_id} className="ticket-documents-row">
              <button
                type="button"
                className="ticket-documents-item"
                title={link.target_label}
                onClick={() => openDocument?.(link.target_id)}
              >
                <FileText aria-hidden="true" />
                <span className="ticket-documents-title">
                  {link.target_label}
                </span>
                {link.target_trashed && (
                  <span className="ticket-documents-badge">Trash</span>
                )}
              </button>
              {link.explicit ? (
                <button
                  type="button"
                  className="ticket-documents-unlink"
                  aria-label={`Unlink ${link.target_label}`}
                  title="Unlink"
                  onClick={() => void change(link.target_id, false)}
                >
                  <X aria-hidden="true" />
                </button>
              ) : (
                <IconButton
                  size="icon-xs"
                  className="ticket-documents-edit"
                  label={`Edit description to remove ${link.target_label}`}
                  onClick={editDescription}
                >
                  <Pencil aria-hidden="true" />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
        {error && <p role="alert">{error}</p>}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="ticket-documents-add"
              aria-label="Add Document"
            >
              <Plus aria-hidden="true" />
              Add
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
