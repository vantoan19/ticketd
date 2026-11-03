import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import { documents, type Document } from "./api";
import { DocumentEditor } from "./DocumentEditor";
import "./documents.css";

function heading(document: Document) {
  return (
    document.title?.trim() ||
    document.body
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ||
    "Untitled"
  );
}
export function Documents({
  capture,
  active,
  onCaptureClose,
  currentTicket,
  onOpenTicket,
  onOpenPlan,
  target,
}: {
  capture: boolean;
  active: boolean;
  onCaptureClose: () => void;
  currentTicket: string | null;
  onOpenTicket: (reference: string) => void;
  onOpenPlan: (id: string) => void;
  target: { id: string; key: number } | null;
}) {
  const [recent, setRecent] = useState<Document[]>([]);
  const [selected, setSelected] = useState<Document | null>(null);
  const [error, setError] = useState("");
  const refresh = () =>
    documents
      .recent()
      .then(setRecent)
      .catch((e: unknown) => setError(String(e)));
  useEffect(() => {
    if (target)
      void documents
        .open(target.id)
        .then(setSelected)
        .catch((e: unknown) => setError(String(e)));
  }, [target]);
  useEffect(() => {
    if (active) void refresh();
  }, [active, capture]);
  return (
    <div className="documents-page">
      <h1>Documents</h1>
      <h2>Recently opened</h2>
      {error && <p role="alert">{error}</p>}
      {recent.length === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyDescription>
              Your captured thoughts will appear here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      <ul>
        {recent.map((document) => (
          <li key={document.id}>
            <Button
              variant="ghost"
              onClick={() =>
                void documents
                  .open(document.id)
                  .then(setSelected)
                  .catch((e: unknown) => setError(String(e)))
              }
            >
              {heading(document)}
            </Button>
          </li>
        ))}
      </ul>
      {selected && (
        <DocumentEditor
          key={selected.id}
          initial={selected}
          onOpenDocument={(id) =>
            void documents
              .open(id)
              .then(setSelected)
              .catch((e: unknown) => setError(String(e)))
          }
          onOpenPlan={(id) => {
            setSelected(null);
            onOpenPlan(id);
          }}
          onOpenTicket={(reference) => {
            setSelected(null);
            onOpenTicket(reference);
          }}
          onClose={() => {
            setSelected(null);
            void refresh();
          }}
        />
      )}
      {capture && (
        <DocumentEditor
          initial={null}
          currentTicket={currentTicket}
          onClose={() => {
            onCaptureClose();
            void refresh();
          }}
        />
      )}
    </div>
  );
}
