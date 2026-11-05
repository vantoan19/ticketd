import { useContext, useEffect, useState } from "react";
import { FileText, Plus } from "lucide-react";
import { documents } from "@/features/documents/api";
import { DocumentNavigation } from "@/features/documents/navigation";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { client, type Ticket } from "@/lib/api/client";
import { DocumentPicker } from "./DocumentPicker";
import { documentLinkMarkdown } from "@/features/documents/document-link";
import { RailSection } from "./RailSection";
import "./ticket-documents.css";

type DocumentLink = Awaited<ReturnType<typeof documents.links>>[0][number];

/** The Documents a ticket links to, with an Add action that links another by title. */
export function TicketDocuments({
  ticket,
  revision,
  updateTicket,
  refresh,
}: {
  ticket: Ticket;
  revision: number;
  updateTicket: (ticket: Ticket) => void;
  refresh: () => Promise<void>;
}) {
  const openDocument = useContext(DocumentNavigation);
  const [links, setLinks] = useState<DocumentLink[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    void documents
      .links(ticket.id)
      .then(([outgoing]) => {
        if (!current) return;
        const seen = new Set<string>();
        setLinks(
          outgoing.filter((link) => {
            if (link.target_kind !== "document" || seen.has(link.target_id))
              return false;
            seen.add(link.target_id);
            return true;
          }),
        );
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [ticket.id, ticket.body, revision]);
  async function add(id: string, heading: string) {
    setOpen(false);
    setError("");
    try {
      const line = documentLinkMarkdown(id, heading);
      const body = ticket.body.trimEnd();
      const result = await client.changeTicket(ticket.reference, {
        body: body ? `${body}\n\n${line}\n` : `${line}\n`,
      });
      updateTicket(result);
      await refresh();
    } catch (reason) {
      setError(String(reason));
    }
  }
  return (
    <RailSection label="Documents">
      <div className="ticket-documents">
        <ul>
          {links.map((link) => (
            <li key={link.target_id}>
              <button
                type="button"
                className="ticket-documents-item"
                title={link.target_label}
                onClick={() => openDocument?.(link.target_id)}
              >
                <FileText aria-hidden="true" />
                <span className="truncate">
                  {link.target_label}
                  {link.target_trashed ? " (Trash)" : ""}
                </span>
              </button>
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
              exclude={links.map((link) => link.target_id)}
              onPick={(picked) => void add(picked.id, picked.heading)}
            />
          </PopoverContent>
        </Popover>
      </div>
    </RailSection>
  );
}
