import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import { documents, type Document } from "./api";
import { DocumentEditor } from "./DocumentEditor";
import "./documents.css";

function heading(document: Document) {
  return (
    document.title?.trim() ||
    document.origin_brief?.trim() ||
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
}: {
  capture: boolean;
  active: boolean;
  onCaptureClose: () => void;
}) {
  const [recent, setRecent] = useState<Document[]>([]);
  const [trash, setTrash] = useState<Document[]>([]);
  const [showTrash, setShowTrash] = useState(false);
  const [selected, setSelected] = useState<Document | null>(null);
  const [error, setError] = useState("");
  const refresh = () =>
    Promise.all([documents.recent(), documents.trash()])
      .then(([recent, trash]) => {
        setRecent(recent);
        setTrash(trash);
      })
      .catch((e: unknown) => setError(String(e)));
  useEffect(() => {
    if (active) void refresh();
  }, [active, capture]);
  return (
    <div className="documents-page">
      <h1>Documents</h1>
      <Button variant="outline" onClick={() => setShowTrash(!showTrash)}>
        {showTrash ? "Recently opened" : "Trash"}
      </Button>
      <h2>{showTrash ? "Trash" : "Recently opened"}</h2>
      {error && <p role="alert">{error}</p>}
      {(showTrash ? trash : recent).length === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyDescription>
              {showTrash
                ? "Trash is empty."
                : "Your captured thoughts will appear here."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      <ul>
        {(showTrash ? trash : recent).map((document) => (
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
          onClose={() => {
            setSelected(null);
            void refresh();
          }}
        />
      )}
      {capture && (
        <DocumentEditor
          initial={null}
          onClose={() => {
            onCaptureClose();
            void refresh();
          }}
        />
      )}
    </div>
  );
}
