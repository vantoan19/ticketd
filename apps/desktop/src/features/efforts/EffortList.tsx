import { useState, type FormEvent } from "react";
import { ArchiveRestore, Layers } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { effortsClient, type Effort } from "@/lib/api/efforts";
import "./effort.css";

/**
 * Efforts to open: the active ones (with a way to create another) or the
 * archived ones, which can be opened or reactivated from here.
 */
export function EffortList({
  efforts,
  archived,
  onOpen,
  refresh,
}: {
  efforts: Effort[];
  archived: boolean;
  onOpen: (id: string) => void;
  refresh: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const shown = efforts.filter((item) => item.archived === archived);

  async function act(change: () => Promise<unknown>) {
    setPending(true);
    setError("");
    try {
      await change();
      await refresh();
      return true;
    } catch (reason) {
      setError(String(reason));
      return false;
    } finally {
      setPending(false);
    }
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setNameError("Enter a name for this Effort.");
      return;
    }
    setNameError("");
    let id = "";
    const created = await act(async () => {
      id = (await effortsClient.create(name)).id;
    });
    if (created) {
      setName("");
      onOpen(id);
    }
  }
  return (
    <section className="effort-index" aria-labelledby="effort-index-heading">
      <h1 id="effort-index-heading">
        {archived ? "Archived Efforts" : "Efforts"}
      </h1>
      <p className="effort-note">
        {archived
          ? "Archived Efforts are hidden from the sidebar. Their tickets stay searchable and unchanged."
          : "Group tickets around a shared objective, across projects."}
      </p>
      {!archived && (
        <form
          className="effort-create"
          onSubmit={(event) => void create(event)}
        >
          <Field data-invalid={nameError ? true : undefined}>
            <FieldLabel htmlFor="effort-create-name">
              New Effort name
            </FieldLabel>
            <Input
              id="effort-create-name"
              value={name}
              autoComplete="off"
              aria-invalid={nameError ? true : undefined}
              onChange={(event) => {
                setName(event.target.value);
                setNameError("");
              }}
            />
            {nameError && <FieldError>{nameError}</FieldError>}
          </Field>
          <Button type="submit" size="sm" disabled={pending}>
            Create Effort
          </Button>
        </form>
      )}
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {shown.length === 0 ? (
        <p className="effort-note">
          {archived ? "No archived Efforts." : "No Efforts yet."}
        </p>
      ) : (
        <ul
          className="effort-index-list"
          aria-label={archived ? "Archived Efforts" : "Active Efforts"}
        >
          {shown.map((item) => (
            <li key={item.id}>
              <button type="button" onClick={() => onOpen(item.id)}>
                <Layers size={16} aria-hidden="true" /> {item.name}
              </button>
              {archived && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  aria-label={`Reactivate ${item.name}`}
                  onClick={() =>
                    void act(() => effortsClient.change(item.id, null, false))
                  }
                >
                  <ArchiveRestore data-icon="inline-start" /> Reactivate
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
