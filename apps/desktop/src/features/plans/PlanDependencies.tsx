import { useEffect, useState } from "react";
import { Layers, Link2, Network, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FailureState } from "@/components/ui/failure-alert";
import {
  GraphCanvas,
  GraphPanel,
  GraphPanelSection,
  GraphRow,
} from "@/components/ui/graph-kit";
import { IconButton } from "@/components/ui/icon-button";
import { StatusLineRegion } from "@/components/ui/status-line";
import { useStatusLine } from "@/components/ui/use-status-line";
import { Canvas, SelectionPanel } from "@/features/tickets/DependencyGraph";
import { byReference } from "@/features/tickets/dependency-graph-model";
import { LinkTicketDialog } from "@/features/tickets/LinkTicketDialog";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import {
  client,
  type DependencyGraph,
  type Project,
  type Ticket,
} from "@/lib/api/client";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { plansClient } from "@/lib/api/plans";
import "./plan-dependencies.css";

type GraphTicket = DependencyGraph["nodes"][number];

/** Blockers that are not Done still hold a ticket back. */
function openBlockers(graph: DependencyGraph, member: GraphTicket) {
  return graph.edges.filter(
    (edge) =>
      edge.dependent === member.reference &&
      graph.nodes.find((node) => node.reference === edge.blocker)?.status !==
        "Done",
  ).length;
}

/**
 * A Plan's members and their outside neighbours as one canvas with the graph
 * kit, and a fixed panel at its right: the Plan's tickets, or the selected
 * ticket's "Blocked by" and "Blocks" with Remove (Undo in the status line) and
 * "Add blocker…" through the shared Link ticket dialog. Membership never
 * changes here.
 */
export function PlanDependencies(props: Props) {
  return (
    <section className="plan-dependencies" aria-label="Plan dependencies">
      <StatusLineRegion>
        <Dependencies {...props} />
      </StatusLineRegion>
    </section>
  );
}

type Props = {
  id: string;
  revision: number;
  projects: Project[];
  refresh: () => Promise<void>;
  onOpen: (reference: string) => void;
  /** Back to the member ticket layout. */
  onClose: () => void;
  /** The Plan is archived, so its blockers can be read but not changed. */
  archived?: boolean;
};

function Dependencies({
  id,
  revision,
  projects,
  refresh,
  onOpen,
  onClose,
  archived = false,
}: Props) {
  const [graph, setGraph] = useState<DependencyGraph | null>(null);
  const [error, setError] = useState<FailureDescription | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [linking, setLinking] = useState<Ticket | null>(null);
  const [pending, setPending] = useState(false);
  const statusLine = useStatusLine();
  useEffect(() => {
    let active = true;
    plansClient.graph(id).then(
      (value) => {
        if (active) {
          setGraph(value);
          setError(null);
        }
      },
      (reason: unknown) => {
        if (active) setError(describeFailure(reason, "load dependencies"));
      },
    );
    return () => {
      active = false;
    };
  }, [id, revision, attempt]);
  async function removeBlocker(blocker: string, dependent: string) {
    setPending(true);
    try {
      await client.changeDependency("remove_dependency", blocker, dependent);
      await refresh();
      statusLine.show({
        message: `Removed ${blocker} as a blocker of ${dependent}`,
        undo: async () => {
          await client.changeDependency("add_dependency", blocker, dependent);
          await refresh();
        },
      });
    } catch (reason: unknown) {
      const failure = describeFailure(reason, `remove ${blocker} as a blocker`);
      statusLine.show({
        tone: "error",
        message: `${failure.title}. ${failure.sentence}`,
        ...(failure.action === "retry" && {
          action: {
            label: "Retry",
            run: () => removeBlocker(blocker, dependent),
          },
        }),
      });
    } finally {
      setPending(false);
    }
  }
  if (error)
    return (
      <div className="plan-dependencies-state">
        <FailureState
          failure={error}
          onRetry={() => setAttempt((value) => value + 1)}
        />
      </div>
    );
  if (!graph)
    return (
      <EmptyState
        size="hint"
        role="status"
        title="Loading dependencies…"
        className="flex-1 self-center"
      />
    );
  const members = byReference(graph.nodes.filter((node) => !node.boundary));
  const outside = graph.nodes.length - members.length;
  const total = graph.total_members ?? members.length;
  const ticket = graph.nodes.find((node) => node.reference === selected);
  const footnote = [
    total > members.length
      ? `Showing ${members.length} of ${total} tickets`
      : null,
    outside > 0
      ? graph.outside_total && graph.outside_total > outside
        ? `Dashed: ${outside} of ${graph.outside_total} tickets outside this Plan`
        : `Dashed: ${outside} ${outside === 1 ? "ticket" : "tickets"} outside this Plan`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const canvas =
    members.length === 0 ? (
      <GraphCanvas
        label="Plan dependencies"
        notice={
          <EmptyState
            anchor="center"
            icon={<Layers />}
            title="No tickets in this Plan"
            description={
              archived
                ? "This archived Plan has no tickets."
                : "Add tickets to the Plan to see how they depend on each other."
            }
          />
        }
      />
    ) : graph.edges.length === 0 ? (
      <GraphCanvas
        label="Plan dependencies"
        notice={
          <EmptyState
            anchor="center"
            icon={<Network />}
            title={
              archived
                ? "This archived Plan has no blockers"
                : "Nothing blocks anything in this Plan yet"
            }
            description={
              archived
                ? "Its tickets can be read but not changed."
                : "When one ticket must finish before another, add a blocker and the order appears here."
            }
            action={
              !archived && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSelected(members[0]?.reference ?? null)}
                >
                  <Link2 data-icon="inline-start" aria-hidden="true" />
                  Add blocker…
                </Button>
              )
            }
          />
        }
      />
    ) : (
      <Canvas
        graph={graph}
        focus={selected}
        selected={selected}
        onSelect={setSelected}
        label="Plan dependencies"
        outsideLabel="outside this Plan"
        footnote={
          footnote && (
            <>
              {footnote}
              {total > members.length && (
                <>
                  {" · "}
                  <Button variant="link" size="sm" onClick={onClose}>
                    See all Plan tickets
                  </Button>
                </>
              )}
            </>
          )
        }
      />
    );
  return (
    <>
      {canvas}
      {ticket ? (
        <SelectionPanel
          key={ticket.reference}
          ticket={ticket}
          nodes={graph.nodes}
          version={graph}
          projects={projects}
          onOpen={onOpen}
          onSelect={setSelected}
          onBack={() => setSelected(null)}
          backLabel="Plan tickets"
          {...(!archived && {
            blockerAction: (reference: string) => (
              <IconButton
                label={`Remove blocker ${reference} from ${ticket.reference}`}
                size="icon-xs"
                tooltipSide="top"
                disabled={pending}
                onClick={() => void removeBlocker(reference, ticket.reference)}
              >
                <X />
              </IconButton>
            ),
            addBlocker: (detail: Ticket) => (
              <Button
                variant="ghost"
                size="sm"
                className="-ml-2 self-start"
                onClick={() => setLinking(detail)}
              >
                <Link2 aria-hidden="true" />
                Add blocker…
              </Button>
            ),
          })}
          note={archived ? "Read-only while archived." : undefined}
        />
      ) : (
        members.length > 0 && (
          <GraphPanel label="Plan tickets">
            <GraphPanelSection title="Tickets" count={members.length}>
              <ul className="plan-dependencies-rows" aria-label="Plan tickets">
                {members.map((member) => {
                  const count = openBlockers(graph, member);
                  return (
                    <li key={member.reference}>
                      <GraphRow
                        icon={
                          <StatusIcon
                            status={member.status}
                            size={16}
                            decorative
                          />
                        }
                        reference={member.reference}
                        caption={
                          count > 0
                            ? `${count} open ${count === 1 ? "blocker" : "blockers"}`
                            : "No open blockers"
                        }
                        title={member.title}
                        onClick={() => setSelected(member.reference)}
                      />
                    </li>
                  );
                })}
              </ul>
            </GraphPanelSection>
          </GraphPanel>
        )
      )}
      {linking && (
        <LinkTicketDialog
          ticket={linking}
          initialKind="blocked_by"
          open
          onOpenChange={(open) => {
            if (!open) setLinking(null);
          }}
          onLinked={refresh}
        />
      )}
    </>
  );
}
