import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { effortsClient, type Effort, type View } from "@/lib/api/efforts";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import "../management.css";

export function Efforts({
  revision,
  refresh,
}: {
  revision: number;
  refresh: () => Promise<void>;
}) {
  const [efforts, setEfforts] = useState<Effort[]>([]);
  const [selected, setSelected] = useState("");
  const [view, setView] = useState<View | null>(null);
  const [name, setName] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [reference, setReference] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState("");
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    try {
      const list = await effortsClient.list();
      const detail = selected ? await effortsClient.show(selected) : null;
      setEfforts(list);
      setView(detail);
      setErrors((old) => ({ ...old, load: "" }));
    } catch (e) {
      setErrors((old) => ({ ...old, load: String(e) }));
    } finally {
      setLoading(false);
    }
  }, [selected]);
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const list = await effortsClient.list();
          const detail = selected ? await effortsClient.show(selected) : null;
          if (active) {
            setEfforts(list);
            setView(detail);
            setErrors((old) => ({ ...old, load: "" }));
          }
        } catch (e) {
          if (active) setErrors((old) => ({ ...old, load: String(e) }));
        } finally {
          if (active) setLoading(false);
        }
      })();
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [selected, revision]);
  async function action(key: string, fn: () => Promise<void>) {
    setPending(key);
    setErrors((old) => ({ ...old, [key]: "" }));
    try {
      await fn();
      await load();
      await refresh();
    } catch (e) {
      setErrors((old) => ({ ...old, [key]: String(e) }));
    } finally {
      setPending("");
    }
  }
  function create(e: FormEvent) {
    e.preventDefault();
    void action("create", async () => {
      const result = await effortsClient.create(name);
      setName("");
      setSelected(result.id);
    });
  }
  const error = (key: string) =>
    errors[key] ? (
      <Alert variant="destructive" role="alert">
        <AlertDescription>{errors[key]}</AlertDescription>
      </Alert>
    ) : null;
  const current = view?.effort.id === selected ? view : null;
  return (
    <section className="management-content" aria-label="Effort management">
      <form onSubmit={create} className="management-form">
        <h2>New Effort</h2>
        <p>Group tickets around a shared objective, across projects.</p>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="management-effort-name">
              Effort name
            </FieldLabel>
            <Input
              id="management-effort-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </Field>
        </FieldGroup>
        {error("create")}
        <div>
          <Button disabled={!!pending}>
            {pending === "create" ? "Creating…" : "Create Effort"}
          </Button>
        </div>
      </form>
      <section className="management-section">
        <h2>Manage Efforts</h2>
        {loading ? (
          <p>Loading Efforts…</p>
        ) : efforts.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyDescription>
                No Efforts yet. Create one to group tickets by objective.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="management-view-effort">
                View Effort
              </FieldLabel>
              <select
                id="management-view-effort"
                value={selected}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setView(null);
                }}
              >
                <option value="">Select an Effort</option>
                {([false, true] as const).map((archived) => {
                  const group = efforts.filter(
                    (item) => item.archived === archived,
                  );
                  return group.length ? (
                    <optgroup
                      key={String(archived)}
                      label={archived ? "Archived" : "Active"}
                    >
                      {group.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </optgroup>
                  ) : null;
                })}
              </select>
            </Field>
          </FieldGroup>
        )}
        {error("load")}
        {selected && !current && !errors.load && <p>Loading Effort…</p>}
        {current && (
          <div className="management-detail">
            <div className="management-heading">
              <h3>{current.effort.name}</h3>
              <span>{current.effort.archived ? "Archived" : "Active"}</span>
            </div>
            <form
              className="management-form"
              onSubmit={(e) => {
                e.preventDefault();
                void action("rename", async () => {
                  await effortsClient.change(
                    selected,
                    drafts[selected] ?? current.effort.name,
                    null,
                  );
                  setDrafts((old) => {
                    const next = { ...old };
                    delete next[selected];
                    return next;
                  });
                });
              }}
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="management-name">Name</FieldLabel>
                  <Input
                    id="management-name"
                    value={drafts[selected] ?? current.effort.name}
                    onChange={(e) =>
                      setDrafts((old) => ({
                        ...old,
                        [selected]: e.target.value,
                      }))
                    }
                    required
                  />
                </Field>
              </FieldGroup>
              {error("rename")}
              <div>
                <Button variant="outline" disabled={!!pending}>
                  {pending === "rename" ? "Saving…" : "Rename"}
                </Button>
              </div>
            </form>
            <div>
              <Button
                variant="outline"
                disabled={!!pending}
                onClick={() =>
                  void action("archive", () =>
                    effortsClient.change(
                      selected,
                      null,
                      !current.effort.archived,
                    ),
                  )
                }
              >
                {pending === "archive"
                  ? "Updating…"
                  : current.effort.archived
                    ? "Reactivate"
                    : "Archive"}
              </Button>
              {error("archive")}
            </div>
            <section>
              <h3>Progress</h3>
              <dl className="management-counts">
                {(
                  [
                    ["Todo", current.counts.todo],
                    ["In progress", current.counts.in_progress],
                    ["In review", current.counts.in_review],
                    ["Done", current.counts.done],
                    ["Canceled", current.counts.canceled],
                  ] as const
                ).map(([label, count]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{count}</dd>
                  </div>
                ))}
              </dl>
            </section>
            <section>
              <h3>Tickets</h3>
              <form
                className="management-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void action("member", async () => {
                    await effortsClient.setMember(reference, selected);
                    setReference("");
                  });
                }}
              >
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="management-ticket-reference">
                      Ticket reference
                    </FieldLabel>
                    <Input
                      id="management-ticket-reference"
                      value={reference}
                      onChange={(e) => setReference(e.target.value)}
                      required
                    />
                  </Field>
                </FieldGroup>
                {error("member")}
                <div>
                  <Button variant="outline" disabled={!!pending}>
                    {pending === "member" ? "Adding…" : "Add member"}
                  </Button>
                </div>
              </form>
              {current.members.length === 0 ? (
                <p>No tickets in this Effort yet.</p>
              ) : (
                <ul className="management-list">
                  {current.members.map((t) => (
                    <li key={t.reference}>
                      <span>
                        <strong>{t.reference}</strong> {t.title} · {t.status}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!!pending}
                        aria-label={`Remove ${t.reference} from Effort`}
                        onClick={() =>
                          void action("remove", () =>
                            effortsClient.setMember(t.reference, null),
                          )
                        }
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {error("remove")}
            </section>
          </div>
        )}
      </section>
    </section>
  );
}
