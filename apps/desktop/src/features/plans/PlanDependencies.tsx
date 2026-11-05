import { useEffect, useState, type FormEvent } from "react";
import { EmptyState } from "@/components/ui/empty-state";
import { ArrowLeft, Layers, Link2, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Canvas, SelectionPanel } from "@/features/tickets/DependencyGraph";
import { byReference } from "@/features/tickets/dependency-graph-model";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import { useTicketSearch } from "@/features/tickets/useTicketSearch";
import {
  client,
  type DependencyGraph,
  type Project,
  type Ticket,
} from "@/lib/api/client";
import { plansClient } from "@/lib/api/plans";
import "@/features/tickets/linked-work.css";

type GraphTicket = DependencyGraph["nodes"][number];

/** Why a blocker holds its dependent back, in the core's own terms. */
function reasonFor(status: string) {
  if (status === "Done") return "Done, so it no longer blocks.";
  if (status === "Canceled" || status === "Duplicate")
    return `${status}, but still blocks until this link is removed.`;
  return `${status}, so it blocks until it is Done.`;
}

/** Says what went wrong in terms of the two tickets, not the core's one-liner. */
function dependencyError(
  reason: unknown,
  blocker: string,
  dependent: string,
): string {
  const text = String(reason);
  if (blocker === dependent) return `${dependent} cannot block itself.`;
  // The core names the loop once; keep it when it is there.
  if (/can.t block\b/i.test(text)) return text.replace(/^Error:\s*/, "");
  if (/cycle/i.test(text))
    return `${dependent} already blocks ${blocker}, directly or through other tickets, so ${blocker} cannot also block it.`;
  if (/not found/i.test(text)) return `No ticket ${blocker} exists.`;
  return text;
}

function Blockers({
  member,
  graph,
  projects,
  refresh,
  onOpen,
  archived,
}: {
  member: GraphTicket;
  graph: DependencyGraph;
  projects: Project[];
  refresh: () => Promise<void>;
  onOpen: (reference: string) => void;
  archived: boolean;
}) {
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<Ticket | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const blockers = graph.edges
    .filter((edge) => edge.dependent === member.reference)
    .map((edge) => edge.blocker);
  const dependents = byReference(
    graph.edges
      .filter((edge) => edge.blocker === member.reference)
      .flatMap((edge) =>
        graph.nodes.filter((node) => node.reference === edge.dependent),
      ),
  );
  const search = useTicketSearch(
    query,
    !chosen,
    (item) =>
      item.reference !== member.reference && !blockers.includes(item.reference),
  );
  async function change(
    kind: "add_dependency" | "remove_dependency",
    ref: string,
  ) {
    setPending(true);
    setError("");
    try {
      await client.changeDependency(kind, ref, member.reference);
      await refresh();
      return true;
    } catch (reason) {
      setError(dependencyError(reason, ref, member.reference));
      return false;
    } finally {
      setPending(false);
    }
  }
  async function add(event: FormEvent) {
    event.preventDefault();
    if (chosen && (await change("add_dependency", chosen.reference))) {
      setChosen(null);
      setQuery("");
      search.reset();
    }
  }
  const visible = query.trim() ? search.results : [];
  // Searching for the ticket itself would otherwise look like a broken search.
  const selfSearch =
    query.trim().toUpperCase() === member.reference ||
    (query.trim().length > 2 &&
      member.title.toLowerCase().includes(query.trim().toLowerCase()) &&
      visible.length === 0);
  return (
    <div className="plan-blockers">
      {blockers.length === 0 ? (
        <p className="plan-note">Nothing blocks {member.reference}.</p>
      ) : (
        <ul aria-label={`Blockers of ${member.reference}`}>
          {blockers.map((reference) => {
            const node = graph.nodes.find(
              (item) => item.reference === reference,
            );
            const project = projects.find(
              (item) => item.id === node?.project_id,
            );
            return (
              <li key={reference}>
                <div className="plan-blocker-main">
                  {node && (
                    <StatusIcon status={node.status} size={14} decorative />
                  )}
                  <button type="button" onClick={() => onOpen(reference)}>
                    <span className="ticket-ref">{reference}</span>{" "}
                    {node?.title}
                  </button>
                  {!archived && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      aria-label={`Remove blocker ${reference} from ${member.reference}`}
                      onClick={() =>
                        void change("remove_dependency", reference)
                      }
                    >
                      Remove
                    </Button>
                  )}
                </div>
                {node && (
                  <p className="plan-note">
                    {[
                      project?.name,
                      node.boundary ? "Outside Plan" : null,
                      reasonFor(node.status),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {dependents.length > 0 && (
        <>
          <p className="plan-note">Blocks</p>
          <ul aria-label={`Tickets blocked by ${member.reference}`}>
            {dependents.map((item) => (
              <li key={item.reference}>
                <div className="plan-blocker-main">
                  <StatusIcon status={item.status} size={14} decorative />
                  <button type="button" onClick={() => onOpen(item.reference)}>
                    <span className="ticket-ref">{item.reference}</span>{" "}
                    {item.title}
                    {projects.find((p) => p.id === item.project_id) &&
                      ` · ${projects.find((p) => p.id === item.project_id)?.name}`}
                    {item.boundary && " · Outside Plan"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {!archived && (
        <form
          className="plan-blocker-form"
          onSubmit={(event) => void add(event)}
        >
          <Field data-invalid={error || search.error ? true : undefined}>
            <FieldLabel htmlFor="plan-blocker">Add a blocker</FieldLabel>
            {chosen ? (
              <div className="link-ticket-chosen">
                <StatusIcon status={chosen.status} size={14} decorative />
                <span>
                  {chosen.reference} {chosen.title}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setChosen(null);
                    setError("");
                  }}
                >
                  Change ticket
                </Button>
              </div>
            ) : (
              <>
                <Input
                  id="plan-blocker"
                  value={query}
                  placeholder="Search by title, text or T-number"
                  autoComplete="off"
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setError("");
                  }}
                />
                {visible.length > 0 && (
                  <ul className="link-ticket-results" aria-label="Matches">
                    {visible.map((item) => (
                      <li key={item.reference}>
                        <button
                          type="button"
                          onClick={() => {
                            setChosen(item);
                            setError("");
                          }}
                        >
                          <StatusIcon
                            status={item.status}
                            size={14}
                            decorative
                          />
                          <span className="link-ticket-reference">
                            {item.reference}
                          </span>
                          <span>{item.title}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
            <FieldError>{error || search.error}</FieldError>
            {!chosen && selfSearch && !error && !search.error && (
              <p className="plan-note">A ticket can’t block itself.</p>
            )}
          </Field>
          <Button type="submit" size="sm" disabled={pending || !chosen}>
            Add blocker
          </Button>
        </form>
      )}
    </div>
  );
}

/** A Plan's members and their outside neighbors, without changing membership. */
export function PlanDependencies({
  id,
  revision,
  projects,
  refresh,
  onOpen,
  onClose,
  archived = false,
}: {
  id: string;
  revision: number;
  projects: Project[];
  refresh: () => Promise<void>;
  onOpen: (reference: string) => void;
  /** Back to the member list. */
  onClose: () => void;
  /** The Plan is archived, so its blockers can be read but not changed. */
  archived?: boolean;
}) {
  const [graph, setGraph] = useState<DependencyGraph | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
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
  const members = graph?.nodes.filter((node) => !node.boundary) ?? [];
  const outside = graph ? graph.nodes.length - members.length : 0;
  const total = graph?.total_members ?? members.length;
  return (
    <section className="plan-dependencies" aria-label="Plan dependencies">
      <header className="plan-dependencies-header">
        <h2>Plan dependencies</h2>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <ArrowLeft aria-hidden="true" />
          Return to list
        </Button>
      </header>
      {error && <p role="alert">{error}</p>}
      {!graph && !error && <p role="status">Loading dependencies…</p>}
      {graph && members.length === 0 && (
        <EmptyState
          icon={<Layers />}
          title="No tickets in this Plan"
          description="Add tickets to the Plan to see how they depend on each other."
        />
      )}
      {graph && members.length > 0 && (
        <>
          {graph.edges.length === 0 ? (
            // Nothing to draw: say what the arrows will mean and how to get one.
            <EmptyState
              icon={<Workflow />}
              title="Nothing blocks anything in this Plan yet"
              description={`${
                members.length === 1
                  ? `${members[0]?.reference} is its only ticket. `
                  : `None of its ${members.length} tickets waits on another. `
              }When one ticket must finish before another, add a blocker and the order appears here.`}
              action={
                !archived && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSelected(members[0]?.reference ?? null)}
                  >
                    Add blocker…
                  </Button>
                )
              }
              footnote="Arrows run from a blocker to the ticket that waits. Dashed tickets are outside this Plan."
            />
          ) : (
            <>
              <div className="plan-graph-canvas">
                <Canvas
                  graph={graph}
                  origin=""
                  selected={selected}
                  onSelect={setSelected}
                  projects={projects}
                  readable
                />
              </div>
              {graph.nodes.find((node) => node.reference === selected) && (
                <SelectionPanel
                  ticket={graph.nodes.find(
                    (node) => node.reference === selected,
                  )!}
                  origin=""
                  projects={projects}
                  nodes={graph.nodes}
                  version={graph}
                  onOpen={onOpen}
                />
              )}
              <p className="plan-note plan-legend">
                Arrows run from blocker to the ticket that waits. Dashed tickets
                are outside this Plan.
              </p>
            </>
          )}
          {total > members.length && (
            <p className="plan-callout" role="status">
              Showing {members.length} of {total} tickets.{" "}
              <button type="button" onClick={onClose}>
                Use the list to see the rest.
              </button>
            </p>
          )}
          {outside > 0 && (
            <p className="plan-callout" role="status">
              {graph.outside_total && graph.outside_total > outside
                ? `${outside} of ${graph.outside_total} outside-Plan tickets shown dashed`
                : `${outside} outside-Plan ${outside === 1 ? "ticket" : "tickets"} shown dashed`}{" "}
              · not included in the {total} member tickets
            </p>
          )}
          <ul className="plan-dependency-rows" aria-label="Plan tickets">
            {members.map((member) => {
              // Only blockers that are not Done still hold the ticket back.
              const count = graph.edges.filter(
                (edge) =>
                  edge.dependent === member.reference &&
                  graph.nodes.find((node) => node.reference === edge.blocker)
                    ?.status !== "Done",
              ).length;
              const open = selected === member.reference;
              const label =
                count > 0
                  ? `${count} open ${count === 1 ? "blocker" : "blockers"}`
                  : archived
                    ? "No blockers"
                    : "Add blocker";
              return (
                <li key={member.reference}>
                  <div className="plan-dependency-row">
                    <StatusIcon status={member.status} size={14} decorative />
                    <span className="plan-dependency-title">
                      <span className="ticket-ref">{member.reference}</span>{" "}
                      {member.title}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-expanded={open}
                      aria-label={`${member.reference}: ${label}`}
                      onClick={() =>
                        setSelected(open ? null : member.reference)
                      }
                    >
                      <Link2 aria-hidden="true" />
                      {label}
                    </Button>
                  </div>
                  {open && (
                    <Blockers
                      key={member.reference}
                      member={member}
                      graph={graph}
                      projects={projects}
                      refresh={refresh}
                      onOpen={onOpen}
                      archived={archived}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
