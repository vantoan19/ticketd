import { useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Handle,
  MarkerType,
  Panel,
  Position,
  useReactFlow,
  useStore,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { ArrowLeft, Maximize, Minus, Plus } from "lucide-react";
import "@xyflow/react/dist/style.css";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { StatusDot } from "@/components/ui/status-dot";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  layoutGraph,
  scopeNotice,
  type GraphTicket,
} from "@/features/tickets/dependency-graph-model";
import {
  client,
  type DependencyGraph as Graph,
  type Project,
  type Relationships,
  type Ticket,
} from "@/lib/api/client";
import type { Plan } from "@/lib/api/plans";
import "./dependency-graph.css";

type NodeData = {
  ticket: GraphTicket;
  origin: boolean;
  selected: boolean;
  onSelect: (reference: string) => void;
};

function AvailabilityMark({ availability }: { availability: string | null }) {
  if (availability !== "Ready" && availability !== "Blocked") return null;
  return (
    <span className="graph-availability">
      <StatusDot tone={availability === "Ready" ? "ready" : "blocked"} />
      {availability}
    </span>
  );
}

function TicketNode({ data }: NodeProps<Node<NodeData>>) {
  const { ticket, origin, selected, onSelect } = data;
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <button
        type="button"
        className="graph-node"
        data-selected={selected || undefined}
        data-origin={origin || undefined}
        aria-pressed={selected}
        onClick={() => onSelect(ticket.reference)}
      >
        <span className="graph-node-line">
          <StatusIcon status={ticket.status} size={14} decorative />
          <span className="graph-node-reference">{ticket.reference}</span>{" "}
          <span className="graph-node-status">{ticket.status}</span>{" "}
          {ticket.trashed && <span className="graph-node-status">Trashed</span>}{" "}
          {origin && <span className="graph-node-origin">Opened from</span>}
          {ticket.boundary && (
            <span className="graph-node-status">Outside Plan</span>
          )}
        </span>{" "}
        <span className="graph-node-title">{ticket.title}</span>{" "}
        <AvailabilityMark availability={ticket.availability} />
      </button>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </>
  );
}
const nodeTypes = { ticket: TicketNode };

function Toolbar() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const zoom = useStore((state) => state.transform[2]);
  return (
    <Panel position="top-left" className="graph-toolbar">
      <IconButton label="Zoom out" onClick={() => void zoomOut()}>
        <Minus />
      </IconButton>
      <span className="graph-zoom" role="status" aria-label="Zoom level">
        {Math.round(zoom * 100)}%
      </span>
      <IconButton label="Zoom in" onClick={() => void zoomIn()}>
        <Plus />
      </IconButton>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void fitView({ padding: 0.2 })}
      >
        <Maximize aria-hidden="true" />
        Fit
      </Button>
    </Panel>
  );
}

export function Canvas({
  graph,
  origin,
  selected,
  onSelect,
}: {
  graph: Graph;
  origin: string;
  selected: string | null;
  onSelect: (reference: string) => void;
}) {
  const positions = useMemo(() => layoutGraph(graph), [graph]);
  const nodes: Node<NodeData>[] = graph.nodes.map((ticket) => ({
    id: ticket.reference,
    type: "ticket",
    position: positions.get(ticket.reference) ?? { x: 0, y: 0 },
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
    data: {
      ticket,
      origin: ticket.reference === origin,
      selected: ticket.reference === selected,
      onSelect,
    },
  }));
  const edges: Edge[] = graph.edges.map((edge) => ({
    id: `${edge.blocker}-${edge.dependent}`,
    source: edge.blocker,
    target: edge.dependent,
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
  }));
  return (
    <ReactFlowProvider>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Toolbar />
      </ReactFlow>
    </ReactFlowProvider>
  );
}

function Legend() {
  return (
    <ul className="graph-legend" aria-label="Legend">
      <li>Arrows point to the work that waits.</li>
      <li>
        A Todo ticket is Ready once every ticket with an arrow into it is Done.
      </li>
      <li>In review, Canceled and Duplicate tickets still block.</li>
      <li>
        <StatusDot tone="ready" /> Ready
      </li>
      <li>
        <StatusDot tone="blocked" /> Blocked
      </li>
    </ul>
  );
}

function TicketList({
  tickets,
  placeholder = "None",
}: {
  tickets: { reference: string; title: string }[] | null;
  /** Shown when there are none, or while they are still loading. */
  placeholder?: string;
}) {
  if (!tickets?.length) return <p className="graph-none">{placeholder}</p>;
  return (
    <ul>
      {tickets.map((ticket) => (
        <li key={ticket.reference}>
          <span className="graph-node-reference">{ticket.reference}</span>{" "}
          {ticket.title}
        </li>
      ))}
    </ul>
  );
}

function SelectionPanel({
  ticket,
  origin,
  projects,
  plans,
  onOpen,
  onBack,
  onCenter,
}: {
  ticket: GraphTicket;
  origin: string;
  projects: Project[];
  plans: Plan[];
  onOpen: (reference: string) => void;
  onBack: () => void;
  onCenter: (reference: string) => void;
}) {
  const [loaded, setLoaded] = useState<{
    ticket: Ticket;
    blocks: Relationships["blocking"];
  } | null>(null);
  // The drawn graph is bounded, so a ticket at its edge has links that are not
  // drawn. The panel lists the ticket's own links from the core instead.
  useEffect(() => {
    let active = true;
    void Promise.all([
      client.showTicket(ticket.reference),
      client.contextualRelationships(ticket.reference, 0),
    ]).then(
      ([value, links]) => {
        if (active) setLoaded({ ticket: value, blocks: links.blocking });
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [ticket.reference]);
  const ready = loaded?.ticket.reference === ticket.reference ? loaded : null;
  const detail = ready?.ticket ?? null;
  const blockedBy = detail?.prerequisites ?? null;
  const blocks = ready?.blocks.items.map((item) => ({
    reference: item.reference,
    title: item.title.text,
  }));
  const project = projects.find((item) => item.id === detail?.project_id);
  const plan = plans.find((item) => item.id === detail?.plan_id);
  const placeholder = detail ? "None" : "Loading…";
  return (
    <aside className="graph-panel" aria-label="Selected ticket">
      <p className="graph-panel-status">
        <StatusIcon status={ticket.status} size={14} decorative />
        {ticket.status}
        {ticket.trashed && " · Trashed"}
      </p>
      <h3>
        <span className="graph-node-reference">{ticket.reference}</span>{" "}
        {ticket.title}
      </h3>
      <AvailabilityMark availability={ticket.availability} />
      <h4>Blocked by</h4>
      <TicketList
        tickets={blockedBy}
        placeholder={detail ? "None" : "Loading…"}
      />
      <h4>Blocks</h4>
      <TicketList
        tickets={blocks ?? null}
        placeholder={ready ? "None" : "Loading…"}
      />
      {ready?.blocks.next_offset != null && (
        <p className="graph-none">More tickets wait on this one.</p>
      )}
      <dl className="graph-panel-facts">
        <dt>Project</dt>
        <dd>{project?.name ?? placeholder}</dd>
        <dt>Plan</dt>
        <dd>{plan?.name ?? placeholder}</dd>
      </dl>
      <div className="graph-panel-actions">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onCenter(ticket.reference)}
        >
          Center graph on {ticket.reference}
        </Button>
        {ticket.reference !== origin && (
          <Button size="sm" onClick={() => onOpen(ticket.reference)}>
            Open {ticket.reference}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={onBack}>
          Back to original ticket
        </Button>
      </div>
    </aside>
  );
}

/** The dependency graph of one ticket, shown as a view of its own. */
export default function DependencyGraph({
  reference,
  revision,
  projects,
  plans,
  onBack,
  onOpen,
}: {
  reference: string;
  revision: number;
  projects: Project[];
  plans: Plan[];
  onBack: () => void;
  onOpen: (reference: string) => void;
}) {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [center, setCenter] = useState(reference);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  useEffect(() => {
    let active = true;
    void client.dependencyGraph(center).then(
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
  }, [center, revision]);
  const notice = graph ? scopeNotice(graph, center) : null;
  const selectedTicket = graph?.nodes.find(
    (node) => node.reference === selected,
  );
  return (
    <section className="dependency-graph-view" aria-label="Dependency graph">
      <header className="graph-header">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          Back to {reference}
        </Button>
        <h2 ref={heading} tabIndex={-1}>
          Dependency graph
        </h2>
      </header>
      <Legend />
      {notice && (
        <p className="graph-notice" role="status">
          {notice}
        </p>
      )}
      {error && <p role="alert">Graph failed: {error}</p>}
      {!graph && !error && <p role="status">Loading graph…</p>}
      {graph && (
        <div className="graph-body">
          <div className="graph-canvas">
            <Canvas
              graph={graph}
              origin={center}
              selected={selected}
              onSelect={setSelected}
            />
          </div>
          {selectedTicket ? (
            <SelectionPanel
              ticket={selectedTicket}
              origin={reference}
              projects={projects}
              plans={plans}
              onOpen={onOpen}
              onBack={onBack}
              onCenter={setCenter}
            />
          ) : (
            <aside className="graph-panel" aria-label="Selected ticket">
              <p className="graph-none">
                Select a ticket to see what it blocks and what blocks it.
              </p>
            </aside>
          )}
        </div>
      )}
    </section>
  );
}
