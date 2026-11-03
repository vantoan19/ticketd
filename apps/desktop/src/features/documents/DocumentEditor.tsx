import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { LazyMarkdownEditor } from "@/features/markdown/LazyMarkdownEditor";
import { documents, type Document } from "./api";

type Snapshot = { title: string; body: string };
type Pending = {
  id: string | null;
  title: string | null;
  body: string | null;
  titleChanged: boolean;
  requestId: string;
  snapshot: Snapshot;
};
export function DocumentEditor({
  initial,
  onClose,
}: {
  initial: Document | null;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [status, setStatus] = useState("Start writing. We’ll save as you go.");
  const [trashed, setTrashed] = useState(initial?.trashed ?? false);
  const [transitioning, setTransitioning] = useState(false);
  const transition = useRef<{ trashed: boolean; requestId: string } | null>(
    null,
  );
  const [failed, setFailed] = useState(false);
  const draft = useRef<Snapshot>({ title, body });
  const saved = useRef<Snapshot>({ title, body });
  const id = useRef(initial?.id ?? null);
  const pending = useRef<Pending | null>(null);
  const saving = useRef(false);
  const closeRequested = useRef(false);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);
  const finishTransition = async () => {
    if (!transition.current || !id.current) return;
    setTransitioning(true);
    try {
      const result = await documents.setTrashed(
        id.current,
        transition.current.trashed,
        transition.current.requestId,
      );
      setTrashed(result.trashed);
      transition.current = null;
      setFailed(false);
      setStatus(result.trashed ? "Moved to Trash" : "Restored");
    } catch (error) {
      setFailed(true);
      setStatus(`Could not update Trash: ${String(error)}`);
    } finally {
      setTransitioning(false);
    }
  };
  const save = async () => {
    if (saving.current) return;
    const snapshot = draft.current;
    const titleChanged = snapshot.title !== saved.current.title;
    const bodyChanged = snapshot.body !== saved.current.body;
    if (!pending.current && !titleChanged && !bodyChanged) {
      if (transition.current) void finishTransition();
      else if (closeRequested.current) close.current();
      return;
    }
    if (
      !pending.current &&
      !id.current &&
      !snapshot.title.trim() &&
      !snapshot.body.trim()
    ) {
      if (closeRequested.current) close.current();
      return;
    }
    const request = pending.current ?? {
      id: id.current,
      title: snapshot.title.trim() ? snapshot.title : null,
      body: !id.current || bodyChanged ? snapshot.body : null,
      titleChanged,
      requestId: crypto.randomUUID(),
      snapshot,
    };
    pending.current = request;
    saving.current = true;
    setStatus("Saving…");
    setFailed(false);
    try {
      const result = await documents.save(
        request.id,
        request.title,
        request.body,
        request.titleChanged,
        request.requestId,
      );
      id.current = result.id;
      saved.current = request.snapshot;
      pending.current = null;
      saving.current = false;
      setStatus("Saved locally");
      if (
        draft.current.title !== saved.current.title ||
        draft.current.body !== saved.current.body
      )
        void save();
      else if (transition.current) void finishTransition();
      else if (closeRequested.current) close.current();
    } catch (error) {
      saving.current = false;
      closeRequested.current = false;
      setFailed(true);
      setStatus(`Could not save: ${String(error)}`);
    }
  };
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });
  useEffect(() => {
    const timer = window.setTimeout(() => void saveRef.current(), 400);
    return () => window.clearTimeout(timer);
  }, [title, body]);
  useEffect(() => {
    // Replacing rich editor content while typing can move its selection or focus.
    const editing = () =>
      document.activeElement instanceof HTMLElement &&
      Boolean(
        document.activeElement.closest(
          "input, textarea, [contenteditable=true], .cm-content",
        ),
      );
    const timer = window.setInterval(() => {
      if (
        !id.current ||
        editing() ||
        saving.current ||
        pending.current ||
        draft.current.title !== saved.current.title ||
        draft.current.body !== saved.current.body
      )
        return;
      void documents
        .show(id.current)
        .then((document) => {
          if (
            editing() ||
            saving.current ||
            pending.current ||
            draft.current.title !== saved.current.title ||
            draft.current.body !== saved.current.body
          )
            return;
          setTrashed(document.trashed);
          const next = { title: document.title ?? "", body: document.body };
          saved.current = next;
          draft.current = next;
          setTitle(next.title);
          setBody(next.body);
        })
        .catch(() => {});
    }, 2000);
    return () => window.clearInterval(timer);
  }, []);
  const requestClose = () => {
    closeRequested.current = true;
    void save();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
    >
      <DialogContent
        className="document-dialog"
        showCloseButton={false}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <header>
          <DialogTitle>
            {initial
              ? initial.title?.trim() ||
                initial.origin_brief?.trim() ||
                "Document"
              : "Capture a thought"}
          </DialogTitle>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close and return"
            onClick={requestClose}
          >
            ×
          </Button>
        </header>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="document-title">Optional title</FieldLabel>
            <Input
              id="document-title"
              placeholder={initial?.origin_brief?.trim() || "Untitled"}
              readOnly={trashed || transitioning}
              value={title}
              onChange={(event) => {
                draft.current = { ...draft.current, title: event.target.value };
                setTitle(event.target.value);
              }}
            />
          </Field>
        </FieldGroup>
        <LazyMarkdownEditor
          value={body}
          onChange={(value) => {
            draft.current = { ...draft.current, body: value };
            setBody(value);
          }}
          label="Your thought"
          readOnly={trashed || transitioning}
          autoFocus
        />
        <footer>
          <span role="status">{status}</span>
          {trashed && <span>This Document is in Trash.</span>}
          {initial && (
            <Button
              variant="outline"
              disabled={transitioning}
              onClick={() => {
                transition.current = {
                  trashed: !trashed,
                  requestId: crypto.randomUUID(),
                };
                void save();
              }}
            >
              {trashed ? "Restore" : "Move to Trash"}
            </Button>
          )}
          {failed && (
            <Button variant="outline" onClick={() => void save()}>
              Retry
            </Button>
          )}
          <Button variant="outline" onClick={requestClose}>
            Back to work
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
