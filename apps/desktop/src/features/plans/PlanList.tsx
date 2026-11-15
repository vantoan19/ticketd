import { useState, type FormEvent } from "react";
import { EmptyState } from "@/components/ui/empty-state";
import { ArchiveRestore, Layers } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Count } from "@/components/ui/count";
import { ManagementPage, PageHeader } from "@/components/ui/page-header";
import { emptyCopy } from "@/lib/empty-copy";
import { plansClient, type Plan } from "@/lib/api/plans";
import "./plan.css";

/**
 * Plans to open: the active ones (with a way to create another) or the
 * archived ones, which can be opened or reactivated from here.
 */
export function PlanList({
  plans,
  archived,
  onOpen,
  onBrowsePlans,
  refresh,
}: {
  plans: Plan[];
  archived: boolean;
  onOpen: (id: string) => void;
  onBrowsePlans?: () => void;
  refresh: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const shown = plans.filter((item) => item.archived === archived);
  const empty = emptyCopy(archived ? "plans-archived" : "plans");

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
      setNameError("Enter a name for this Plan.");
      return;
    }
    setNameError("");
    let id = "";
    const created = await act(async () => {
      id = (await plansClient.create(name)).id;
    });
    if (created) {
      setName("");
      onOpen(id);
    }
  }
  return (
    <ManagementPage aria-labelledby="plan-index-heading">
      <PageHeader
        title={archived ? "Archived Plans" : "Plans"}
        titleId="plan-index-heading"
        {...(shown.length > 0 && { count: <Count>{shown.length}</Count> })}
        lede={
          archived
            ? "Archived Plans are hidden from the sidebar. Their tickets stay searchable and unchanged."
            : "Group tickets around a shared objective, across projects."
        }
      />
      {!archived && (
        <form className="plan-create" onSubmit={(event) => void create(event)}>
          <Field data-invalid={nameError ? true : undefined}>
            <FieldLabel htmlFor="plan-create-name">New Plan name</FieldLabel>
            <Input
              id="plan-create-name"
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
            Create Plan
          </Button>
        </form>
      )}
      {error && (
        <Alert tone="error" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {shown.length === 0 ? (
        // The create form above already fills this page; no second action.
        <EmptyState
          icon={<Layers />}
          title={empty.title}
          description={empty.sentence}
          action={
            archived &&
            onBrowsePlans && (
              <Button variant="outline" size="sm" onClick={onBrowsePlans}>
                Show active Plans
              </Button>
            )
          }
        />
      ) : (
        <ul
          className="plan-index-list"
          aria-label={archived ? "Archived Plans" : "Active Plans"}
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
                    void act(() => plansClient.change(item.id, null, false))
                  }
                >
                  <ArchiveRestore data-icon="inline-start" /> Reactivate
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </ManagementPage>
  );
}
