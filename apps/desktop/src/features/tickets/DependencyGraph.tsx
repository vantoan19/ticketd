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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { StatusDot } from "@/components/ui/status-dot";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  boundsOf,
  byReference,
  fitViewport,
  layoutGraph,
  openViewport,
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
  project?: string | undefined;
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
  const { ticket, origin, selected, project, onSelect } = data;
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <button
        type="button"
        className="graph-node"
        data-selected={selected || undefined}
        data-origin={origin || undefined}
        data-boundary={ticket.boundary || undefined}
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
        <span className="graph-node-foot">
          <AvailabilityMark availability={ticket.availability} />
          {project && <span className="graph-node-status">{project}</span>}
        </span>
      </button>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </>
  );
}
const nodeTypes = { ticket: TicketNode };
/** Smallest zoom that still reads; the graph opens no smaller than this. */
const READABLE_ZOOM = 0.7;
/** Fit may zoom out this far so the whole graph is always visible. */
const OVERVIEW_ZOOM = 0.2;

function Toolbar({
  positions,
}: {
  positions: Map<string, { x: number; y: number }>;
}) {
  const { zoomIn, zoomOut, setViewport } = useReactFlow();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const [panX, panY, zoom] = useStore((state) => state.transform);
  // Tickets wholly outside the view, so a dense graph never silently hides some.
  let offscreen = 0;
  if (width && height)
    for (const at of positions.values()) {
      const left = at.x * zoom + panX;
      const top = at.y * zoom + panY;
      if (
        left + NODE_WIDTH * zoom < 0 ||
        left > width ||
        top + NODE_HEIGHT * zoom < 0 ||
        top > height
      )
        offscreen++;
    }
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
        onClick={() => {
          const bounds = boundsOf(positions, positions.keys());
          if (bounds)
            void setViewport(
              fitViewport(
                bounds,
                { width, height },
                { minZoom: OVERVIEW_ZOOM, maxZoom: 1 },
              ),
            );
        }}
      >
        <Maximize aria-hidden="true" />
        Fit
      </Button>
      {offscreen > 0 && (
        <span className="graph-zoom" role="status">
          {offscreen} {offscreen === 1 ? "ticket" : "tickets"} off-screen
        </span>
      )}
    </Panel>
  );
}

/** Sets the opening view once the canvas has a size. */
function OpenView({
  graph,
  positions,
  origin,
  selected,
  readable,
}: {
  graph: Graph;
  positions: Map<string, { x: number; y: number }>;
  origin: string;
  selected: string | null;
  readable: boolean;
}) {
  const { setViewport } = useReactFlow();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !width || !height) return;
    opened.current = true;
    const view = readable
      ? openViewport(
          graph,
          positions,
          selected ?? origin,
          { width, height },
          READABLE_ZOOM,
        )
      : (() => {
          const bounds = boundsOf(positions, positions.keys());
          return bounds
            ? fitViewport(
                bounds,
                { width, height },
                { minZoom: OVERVIEW_ZOOM, maxZoom: 1 },
              )
            : null;
        })();
    if (view) void setViewport(view);
  }, [
    graph,
    positions,
    origin,
    selected,
    readable,
    width,
    height,
    setViewport,
  ]);
  return null;
}

export function Canvas({
  graph,
  origin,
  selected,
  onSelect,
  projects,
  readable = false,
}: {
  graph: Graph;
  origin: string;
  selected: string | null;
  onSelect: (reference: string) => void;
  /** When given, each node names its project. */
  projects?: Project[];
  /** Keep text legible: large graphs scroll instead of shrinking past it. */
  readable?: boolean;
}) {
  // Positions depend only on which tickets and edges exist, so a refresh that
  // returns the same graph keeps the layout (and its identity) as it was.
  const topology = useMemo(
    () =>
      JSON.stringify([graph.nodes.map((node) => node.reference), graph.edges]),
    [graph],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const positions = useMemo(() => layoutGraph(graph), [topology]);
  // Nodes and edges keep their identity until the graph or selection changes,
  // and the flow remounts for a new graph so every handle is measured afresh;
  // otherwise arrows can vanish after a blocker is added or removed.
  const shape = useMemo(
    () =>
      JSON.stringify([
        graph.nodes.map((node) => [node.reference, node.status]),
        graph.edges,
      ]),
    [graph],
  );
  const nodes: Node<NodeData>[] = useMemo(
    () =>
      graph.nodes.map((ticket) => ({
        id: ticket.reference,
        type: "ticket",
        position: positions.get(ticket.reference) ?? { x: 0, y: 0 },
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        data: {
          ticket,
          origin: ticket.reference === origin,
          selected: ticket.reference === selected,
          project: projects?.find((item) => item.id === ticket.project_id)
            ?.name,
          onSelect,
        },
      })),
    [graph, positions, origin, selected, onSelect, projects],
  );
  const edges: Edge[] = useMemo(
    () =>
      graph.edges.map((edge) => ({
        id: `${edge.blocker}-${edge.dependent}`,
        source: edge.blocker,
        target: edge.dependent,
        // Each edge keeps its own curve; a stepped route would merge the edges of
        // a hub into one shared bus.
        type: "default",
        // The marker's arrow is a quarter of its box, so the box is large.
        markerEnd: { type: MarkerType.ArrowClosed, width: 40, height: 40 },
      })),
    [graph],
  );
  return (
    <ReactFlowProvider key={shape}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        minZoom={OVERVIEW_ZOOM}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <OpenView
          graph={graph}
          positions={positions}
          origin={origin}
          selected={selected}
          readable={readable}
        />
        <Toolbar positions={positions} />
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
  projectOf,
}: {
  tickets: { reference: string; title: string; status?: string }[] | null;
  /** Names the project a ticket belongs to, when it is known. */
  projectOf?: (reference: string) => string | undefined;
  /** Shown when there are none, or while they are still loading. */
  placeholder?: string;
}) {
  if (!tickets?.length) return <p className="graph-none">{placeholder}</p>;
  return (
    <ul>
      {byReference(tickets).map((ticket) => (
        <li key={ticket.reference}>
          {ticket.status && (
            <StatusIcon status={ticket.status} size={14} decorative />
          )}{" "}
          <span className="graph-node-reference">{ticket.reference}</span>{" "}
          {ticket.title}
          {projectOf?.(ticket.reference) && (
            <span className="graph-none"> · {projectOf(ticket.reference)}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function SelectionPanel({
  ticket,
  origin,
  projects,
  plans,
  onOpen,
  onBack,
  onCenter,
  nodes,
  version,
}: {
  ticket: GraphTicket;
  /** The drawn tickets, used to name the project of each listed ticket. */
  nodes?: GraphTicket[];
  /** Changes whenever the graph reloads, so the lists never show an older answer. */
  version?: unknown;
  origin: string;
  projects: Project[];
  /** Without Plans the panel leaves out the Plan line. */
  plans?: Plan[];
  onOpen: (reference: string) => void;
  /** With neither back nor center the panel is compact: facts and Open only. */
  onBack?: () => void;
  onCenter?: (reference: string) => void;
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
  }, [ticket.reference, version]);
  const ready = loaded?.ticket.reference === ticket.reference ? loaded : null;
  const detail = ready?.ticket ?? null;
  const blockedBy = detail?.prerequisites ?? null;
  const blocks = ready?.blocks.items.map((item) => ({
    reference: item.reference,
    title: item.title.text,
    status: item.status,
  }));
  const project = projects.find((item) => item.id === detail?.project_id);
  const plan = plans?.find((item) => item.id === detail?.plan_id);
  const placeholder = detail ? "None" : "Loading…";
  const projectOf = (reference: string) =>
    projects.find(
      (item) =>
        item.id ===
        nodes?.find((node) => node.reference === reference)?.project_id,
    )?.name;
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
        projectOf={projectOf}
      />
      <h4>Blocks</h4>
      <TicketList
        tickets={blocks ?? null}
        placeholder={ready ? "None" : "Loading…"}
        projectOf={projectOf}
      />
      {ready?.blocks.next_offset != null && (
        <p className="graph-none">More tickets wait on this one.</p>
      )}
      <dl className="graph-panel-facts">
        <dt>Project</dt>
        <dd>{project?.name ?? placeholder}</dd>
        {plans && (
          <>
            <dt>Plan</dt>
            <dd>{plan?.name ?? placeholder}</dd>
          </>
        )}
      </dl>
      <div className="graph-panel-actions">
        {onCenter && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onCenter(ticket.reference)}
          >
            Center graph on {ticket.reference}
          </Button>
        )}
        {ticket.reference !== origin && (
          <Button size="sm" onClick={() => onOpen(ticket.reference)}>
            Open {ticket.reference}
          </Button>
        )}
        {onBack && (
          <Button variant="outline" size="sm" onClick={onBack}>
            Back to original ticket
          </Button>
        )}
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
        <Alert role="status" size="compact">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
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
              nodes={graph.nodes}
              version={graph}
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
