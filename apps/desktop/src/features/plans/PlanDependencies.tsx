import { useEffect, useState, type FormEvent } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Canvas } from "@/features/tickets/DependencyGraph";
import { client, type DependencyGraph } from "@/lib/api/client";
import { plansClient } from "@/lib/api/plans";
import type { PlanViewState } from "./usePlanView";

/** A Plan's members and their outside prerequisites, without changing membership. */
export function PlanDependencies({
  id,
  revision,
  state,
  onOpen,
}: {
  id: string;
  revision: number;
  state: PlanViewState;
  onOpen: (reference: string) => void;
}) {
  const [graph, setGraph] = useState<DependencyGraph | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [blocker, setBlocker] = useState("");
  useEffect(() => {
    let active = true;
    plansClient.graph(id).then(
      (value) => {
        if (active) {
          setGraph(value);
          setError("");
        }
      },
      (reason: unknown) => {
        if (active) setError(String(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [id, revision]);
  async function add(event: FormEvent) {
    event.preventDefault();
    if (
      selected &&
      blocker.trim() &&
      (await state.run(() =>
        client.changeDependency("add_dependency", blocker.trim(), selected),
      ))
    )
      setBlocker("");
  }
  const ticket = graph?.nodes.find((item) => item.reference === selected);
  return (
    <section className="dependency-graph-view" aria-label="Plan dependencies">
      <p>
        Arrows point from blockers to the work that waits. Outside Plan tickets
        do not count as members.
      </p>
      {graph?.truncated && (
        <p role="status">
          This graph is limited; some tickets or dependencies are omitted. Open
          a ticket to explore its dependencies.
        </p>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {!graph && !error && <p role="status">Loading dependencies…</p>}
      {graph && graph.nodes.length === 0 && <p>No tickets in this Plan.</p>}
      {graph && graph.nodes.length > 0 && (
        <div className="graph-body">
          <div className="graph-canvas">
            <Canvas
              graph={graph}
              origin=""
              selected={selected}
              onSelect={setSelected}
            />
          </div>
          <aside className="graph-panel" aria-label="Selected ticket">
            {ticket ? (
              <>
                <h3>
                  {ticket.reference} · {ticket.title}
                </h3>
                <p>
                  {ticket.status}
                  {ticket.availability ? ` · ${ticket.availability}` : ""}
                  {ticket.boundary ? " · Outside Plan" : ""}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onOpen(ticket.reference)}
                >
                  Open ticket
                </Button>
                {!ticket.boundary && (
                  <>
                    <h4>Blocked by</h4>
                    <ul>
                      {graph.edges
                        .filter((edge) => edge.dependent === ticket.reference)
                        .map((edge) => (
                          <li key={edge.blocker}>
                            {edge.blocker}{" "}
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={state.pending}
                              onClick={() =>
                                void state.run(() =>
                                  client.changeDependency(
                                    "remove_dependency",
                                    edge.blocker,
                                    edge.dependent,
                                  ),
                                )
                              }
                            >
                              Remove blocker {edge.blocker}
                            </Button>
                          </li>
                        ))}
                    </ul>
                    <form onSubmit={(event) => void add(event)}>
                      <Field>
                        <FieldLabel htmlFor="plan-blocker">
                          Blocker ticket reference
                        </FieldLabel>
                        <Input
                          id="plan-blocker"
                          value={blocker}
                          onChange={(event) => setBlocker(event.target.value)}
                        />
                      </Field>
                      <Button
                        type="submit"
                        size="sm"
                        disabled={state.pending || !blocker.trim()}
                      >
                        Add blocker
                      </Button>
                    </form>
                  </>
                )}
              </>
            ) : (
              <p>Select a ticket to inspect and edit its blockers.</p>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}
