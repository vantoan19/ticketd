import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Handle,
  MarkerType,
  Position,
  useReactFlow,
  useStore,
  useStoreApi,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { ArrowLeft, Network } from "lucide-react";
import "@xyflow/react/dist/style.css";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FailureState } from "@/components/ui/failure-alert";
import { GRAPH_ZOOM } from "@/components/ui/graph-zoom";
import {
  AvailabilityMark,
  GraphCanvas,
  GraphLegend,
  GraphNodeCard,
  GraphPanel,
  GraphPanelActions,
  GraphPanelHead,
  GraphPanelSection,
  GraphRow,
  ZoomControls,
  type LegendMark,
} from "@/components/ui/graph-kit";
import { Reference } from "@/components/ui/reference";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
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
  selected: boolean;
  onSelect: (reference: string) => void;
};

/** "Todo", or "Todo · In Trash": the status word a card and a row show. */
function statusMeta(ticket: { status: string; trashed?: boolean }) {
  return ticket.trashed ? `${ticket.status} · In Trash` : ticket.status;
}

function TicketNode({ data }: NodeProps<Node<NodeData>>) {
  const { ticket, selected, onSelect } = data;
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <GraphNodeCard
        icon={<StatusIcon status={ticket.status} size={14} decorative />}
        reference={ticket.reference}
        meta={statusMeta(ticket)}
        trailing={<AvailabilityMark availability={ticket.availability} />}
        title={ticket.title}
        selected={selected}
        outside={ticket.boundary ?? false}
        aria-label={[
          `${ticket.reference} ${ticket.title}`,
          statusMeta(ticket),
          ticket.availability,
        ]
          .filter(Boolean)
          .join(", ")}
        aria-pressed={selected}
        onClick={() => onSelect(ticket.reference)}
      />
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </>
  );
}
const nodeTypes = { ticket: TicketNode };

/** A small closed arrow in the edge colour: only "blocks" has one. */
const ARROW = {
  type: MarkerType.ArrowClosed,
  width: 22,
  height: 22,
  color: "var(--muted-foreground)",
} as const;

/** Cards wholly or partly outside the view, so a dense graph never silently hides some. */
function notInView(
  positions: Map<string, { x: number; y: number }>,
  [panX, panY, zoom]: [number, number, number],
  width: number,
  height: number,
) {
  if (!width || !height) return 0;
  let count = 0;
  for (const at of positions.values()) {
    const left = at.x * zoom + panX;
    const top = at.y * zoom + panY;
    if (
      left < -0.5 ||
      top < -0.5 ||
      left + NODE_WIDTH * zoom > width + 0.5 ||
      top + NODE_HEIGHT * zoom > height + 0.5
    )
      count++;
  }
  return count;
}

function Zoom({
  positions,
}: {
  positions: Map<string, { x: number; y: number }>;
}) {
  const { zoomIn, zoomOut, zoomTo, setViewport } = useReactFlow();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const transform = useStore((state) => state.transform);
  return (
    <ZoomControls
      zoom={transform[2]}
      onZoomOut={() => void zoomOut()}
      onZoomIn={() => void zoomIn()}
      onReset={() => void zoomTo(1)}
      onFit={() => {
        const bounds = boundsOf(positions, positions.keys());
        if (bounds)
          void setViewport(
            fitViewport(
              bounds,
              { width, height },
              { minZoom: GRAPH_ZOOM.fit, maxZoom: 1 },
            ),
          );
      }}
      notInView={notInView(positions, transform, width, height)}
    />
  );
}

/** Sets the opening view once the canvas has a size: 100%, around the focus ticket. */
function OpenView({
  graph,
  positions,
  focus,
}: {
  graph: Graph;
  positions: Map<string, { x: number; y: number }>;
  focus: string | null;
}) {
  const { setViewport } = useReactFlow();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !width || !height) return;
    opened.current = true;
    const view = openViewport(
      graph,
      positions,
      focus,
      { width, height },
      GRAPH_ZOOM.fit,
    );
    if (view) void setViewport(view);
  }, [graph, positions, focus, width, height, setViewport]);
  return null;
}

/** Brings a ticket selected from a list into view; one already in view stays put. */
function FollowSelection({
  positions,
  selected,
}: {
  positions: Map<string, { x: number; y: number }>;
  selected: string | null;
}) {
  const { setCenter } = useReactFlow();
  const store = useStoreApi();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const previous = useRef(selected);
  useEffect(() => {
    if (previous.current === selected) return;
    previous.current = selected;
    const at = selected ? positions.get(selected) : undefined;
    if (!at || !width || !height) return;
    const [x, y, zoom] = store.getState().transform;
    const left = at.x * zoom + x;
    const top = at.y * zoom + y;
    const inside =
      left >= 0 &&
      top >= 0 &&
      left + NODE_WIDTH * zoom <= width &&
      top + NODE_HEIGHT * zoom <= height;
    if (!inside)
      void setCenter(at.x + NODE_WIDTH / 2, at.y + NODE_HEIGHT / 2, {
        zoom,
        duration: 200,
      });
  }, [selected, positions, width, height, setCenter, store]);
  return null;
}

/** What the legend lists: only the marks this graph shows. */
function legendItems(graph: Graph, outsideLabel: string) {
  const items: { mark: LegendMark; label: string }[] = [];
  if (graph.edges.length) items.push({ mark: "blocks", label: "blocks" });
  if (graph.nodes.some((node) => node.availability === "Ready"))
    items.push({ mark: "ready", label: "Ready" });
  if (graph.nodes.some((node) => node.availability === "Blocked"))
    items.push({ mark: "blocked", label: "Blocked" });
  if (graph.nodes.some((node) => node.boundary))
    items.push({ mark: "outside", label: outsideLabel });
  return items;
}

/**
 * A dependency graph drawn with the graph kit: blockers above the tickets
 * they block, one arrow per "blocks", the legend top-right and the zoom
 * control bottom-left. It opens at 100% around `focus` and pans from there.
 */
export function Canvas({
  graph,
  focus,
  selected,
  onSelect,
  label,
  outsideLabel = "outside",
  notice,
  footnote,
}: {
  graph: Graph;
  /** The ticket the view opens around (the centre, or the first selected). */
  focus: string | null;
  selected: string | null;
  onSelect: (reference: string) => void;
  label: string;
  /** How the legend names a dashed card ("outside this Plan"). */
  outsideLabel?: string;
  /** An empty state centred in the canvas. */
  notice?: ReactNode;
  footnote?: ReactNode;
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
          selected: ticket.reference === selected,
          onSelect,
        },
      })),
    [graph, positions, selected, onSelect],
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
        markerEnd: ARROW,
      })),
    [graph],
  );
  return (
    <ReactFlowProvider key={shape}>
      <GraphCanvas
        label={label}
        legend={<GraphLegend items={legendItems(graph, outsideLabel)} />}
        zoom={<Zoom positions={positions} />}
        notice={notice}
        footnote={footnote}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          minZoom={GRAPH_ZOOM.min}
          maxZoom={GRAPH_ZOOM.max}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          zoomOnDoubleClick={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
          <OpenView graph={graph} positions={positions} focus={focus} />
          <FollowSelection positions={positions} selected={selected} />
        </ReactFlow>
      </GraphCanvas>
    </ReactFlowProvider>
  );
}

type Linked = { reference: string; title: string; status?: string };

/**
 * One relationship list in the panel. A row selects its ticket when the graph
 * draws it, and otherwise centres the graph on it (or opens it).
 */
function LinkedRows({
  tickets,
  nodes,
  onRow,
  rowAction,
}: {
  tickets: Linked[];
  nodes: GraphTicket[];
  onRow: (reference: string) => void;
  rowAction?: ((reference: string) => ReactNode) | undefined;
}) {
  return (
    <ul className="tgraph-rows">
      {byReference(tickets).map((ticket) => {
        const drawn = nodes.find((node) => node.reference === ticket.reference);
        const status = drawn?.status ?? ticket.status;
        return (
          <li key={ticket.reference}>
            <GraphRow
              icon={
                status ? (
                  <StatusIcon status={status} size={16} decorative />
                ) : (
                  <span />
                )
              }
              reference={ticket.reference}
              caption={drawn?.availability ?? status ?? ""}
              title={ticket.title}
              onClick={() => onRow(ticket.reference)}
              trailing={rowAction?.(ticket.reference)}
            />
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The selected ticket in the graph kit's side panel: its status, title and
 * place (Plan, project), what blocks it and what it blocks, then "Open {ref}"
 * and "Center here". The lists come from the core, so links the bounded graph
 * leaves out still show. A failed load says so and offers Retry.
 */
export function SelectionPanel({
  ticket,
  nodes,
  version,
  center,
  projects,
  plans,
  onOpen,
  onSelect,
  onCenter,
  blockerAction,
  addBlocker,
  note,
  onBack,
  backLabel,
}: {
  ticket: GraphTicket;
  /** The drawn tickets; a listed ticket that is drawn is selected, not left. */
  nodes: GraphTicket[];
  /** Changes whenever the graph reloads, so the lists never show an older answer. */
  version?: unknown;
  /** The graph's centre: Center here is left out for it. */
  center?: string | undefined;
  projects: Project[];
  /** Without Plans the caption leaves out the Plan. */
  plans?: Plan[];
  onOpen: (reference: string) => void;
  onSelect: (reference: string) => void;
  onCenter?: ((reference: string) => void) | undefined;
  /** A hover action for each "Blocked by" row (Remove). */
  blockerAction?: ((reference: string) => ReactNode) | undefined;
  /** After the "Blocked by" rows ("Add blocker…"), given the loaded ticket. */
  addBlocker?: ((detail: Ticket) => ReactNode) | undefined;
  /** A caption under the lists ("Read-only while archived"). */
  note?: string | undefined;
  /** A way back to what the panel showed before (the Plan's tickets). */
  onBack?: (() => void) | undefined;
  backLabel?: string;
}) {
  const [loaded, setLoaded] = useState<{
    ticket: Ticket;
    blocks: Relationships["blocking"];
  } | null>(null);
  // A failure belongs to the ticket it was for; selecting another leaves it.
  const [failed, setFailed] = useState<{
    reference: string;
    failure: FailureDescription;
  } | null>(null);
  const failure =
    failed?.reference === ticket.reference ? failed.failure : null;
  const [attempt, setAttempt] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.all([
      client.showTicket(ticket.reference),
      client.contextualRelationships(ticket.reference, 0),
    ]).then(
      ([value, links]) => {
        if (!active) return;
        setLoaded({ ticket: value, blocks: links.blocking });
        setFailed(null);
      },
      (reason: unknown) => {
        if (active)
          setFailed({
            reference: ticket.reference,
            failure: describeFailure(
              reason,
              `load what blocks ${ticket.reference}`,
            ),
          });
      },
    );
    return () => {
      active = false;
    };
  }, [ticket.reference, version, attempt]);
  const ready = loaded?.ticket.reference === ticket.reference ? loaded : null;
  const detail = ready?.ticket ?? null;
  const blockedBy = detail?.prerequisites ?? [];
  const blocks =
    ready?.blocks.items.map((item) => ({
      reference: item.reference,
      title: item.title.text,
      status: item.status,
    })) ?? [];
  const more = ready?.blocks.next_offset ?? null;
  const showMore = async () => {
    if (more === null || !ready) return;
    setLoadingMore(true);
    try {
      const page = await client.contextualRelationships(ticket.reference, more);
      setLoaded((previous) =>
        previous && previous.ticket.reference === ticket.reference
          ? {
              ...previous,
              blocks: {
                items: [...previous.blocks.items, ...page.blocking.items],
                next_offset: page.blocking.next_offset,
              },
            }
          : previous,
      );
    } catch (reason: unknown) {
      setFailed({
        reference: ticket.reference,
        failure: describeFailure(
          reason,
          `load what ${ticket.reference} blocks`,
        ),
      });
    } finally {
      setLoadingMore(false);
    }
  };
  const plan = plans?.find((item) => item.id === detail?.plan_id)?.name;
  const project = projects.find((item) => item.id === detail?.project_id)?.name;
  const caption = [statusMeta(ticket), plan, project]
    .filter(Boolean)
    .join(" · ");
  const onRow = (reference: string) => {
    if (nodes.some((node) => node.reference === reference)) onSelect(reference);
    else if (onCenter) onCenter(reference);
    else onOpen(reference);
  };
  const firstBlocker = blockedBy.find((item) =>
    nodes.some(
      (node) =>
        node.reference === item.reference &&
        node.status !== "Done" &&
        node.availability !== null,
    ),
  );
  return (
    <GraphPanel
      label="Selected ticket"
      footer={
        <GraphPanelActions
          openLabel={`Open ${ticket.reference}`}
          onOpen={() => onOpen(ticket.reference)}
          {...(onCenter &&
            ticket.reference !== center && {
              onCenter: () => onCenter(ticket.reference),
            })}
        />
      }
    >
      {onBack && (
        <Button
          variant="ghost"
          size="sm"
          className="-my-2 -ml-2 self-start"
          onClick={onBack}
        >
          <ArrowLeft aria-hidden="true" />
          {backLabel ?? "Back"}
        </Button>
      )}
      <GraphPanelHead
        icon={<StatusIcon status={ticket.status} size={14} decorative />}
        eyebrow={<Reference>{ticket.reference}</Reference>}
        title={ticket.title}
        caption={caption}
      />
      <AvailabilityMark availability={ticket.availability}>
        {ticket.availability === "Blocked" && firstBlocker
          ? `Blocked by ${firstBlocker.reference}`
          : undefined}
      </AvailabilityMark>
      {failure ? (
        <FailureState
          size="inline"
          failure={failure}
          onRetry={() => {
            setFailed(null);
            setAttempt((value) => value + 1);
          }}
        />
      ) : !ready ? (
        <p className="tgraph-loading" role="status">
          Loading…
        </p>
      ) : (
        <>
          <GraphPanelSection title="Blocked by" count={blockedBy.length}>
            {blockedBy.length > 0 ? (
              <LinkedRows
                tickets={blockedBy}
                nodes={nodes}
                onRow={onRow}
                rowAction={blockerAction}
              />
            ) : (
              <p>Nothing blocks {ticket.reference}.</p>
            )}
            {detail && addBlocker?.(detail)}
          </GraphPanelSection>
          <GraphPanelSection title="Blocks" count={blocks.length}>
            {blocks.length > 0 ? (
              <LinkedRows tickets={blocks} nodes={nodes} onRow={onRow} />
            ) : (
              <p>Nothing waits on {ticket.reference}.</p>
            )}
            {more !== null && (
              <Button
                variant="link"
                size="sm"
                className="self-start"
                disabled={loadingMore}
                onClick={() => void showMore()}
              >
                Show more
              </Button>
            )}
          </GraphPanelSection>
          {note && <p className="tgraph-note">{note}</p>}
        </>
      )}
    </GraphPanel>
  );
}

/** The tickets of a dependency graph as rows, blockers first: the List view. */
function TicketRows({
  graph,
  selected,
  onSelect,
}: {
  graph: Graph;
  selected: string | null;
  onSelect: (reference: string) => void;
}) {
  return (
    <div className="tgraph-list">
      <ul aria-label="Tickets">
        {byReference(graph.nodes).map((ticket) => (
          <li key={ticket.reference}>
            <GraphRow
              icon={<StatusIcon status={ticket.status} size={16} decorative />}
              reference={ticket.reference}
              caption={[statusMeta(ticket), ticket.availability]
                .filter(Boolean)
                .join(" · ")}
              title={ticket.title}
              current={ticket.reference === selected}
              onClick={() => onSelect(ticket.reference)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A ticket's dependencies inside the graph shell: the bounded graph of tickets
 * joined to `reference` by "blocks", as a canvas or a list, with the selection
 * panel at the right. The ticket itself starts selected.
 */
export function DependencyView({
  reference,
  revision,
  projects,
  plans,
  view,
  onOpen,
  onCenter,
  onCount,
}: {
  reference: string;
  revision: number;
  projects: Project[];
  plans: Plan[];
  view: "graph" | "list";
  onOpen: (reference: string) => void;
  /** Centre the graph on another ticket (the shell keeps the way back). */
  onCenter: (reference: string) => void;
  /** Reports how many tickets are drawn, for the header count. */
  onCount?: (count: number | null) => void;
}) {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [error, setError] = useState<FailureDescription | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<string | null>(reference);
  const count = useRef(onCount);
  useEffect(() => {
    count.current = onCount;
  }, [onCount]);
  useEffect(() => {
    let active = true;
    void client.dependencyGraph(reference).then(
      (value) => {
        if (!active) return;
        setGraph(value);
        setError(null);
        count.current?.(value.nodes.length);
        setSelected((previous) =>
          previous && value.nodes.some((node) => node.reference === previous)
            ? previous
            : reference,
        );
      },
      (reason: unknown) => {
        if (active) setError(describeFailure(reason, "load the dependencies"));
      },
    );
    return () => {
      active = false;
    };
  }, [reference, revision, attempt]);
  useEffect(() => () => count.current?.(null), []);
  const select = useCallback((value: string) => setSelected(value), []);
  if (error)
    return (
      <div className="tgraph-body" data-state="failed">
        <FailureState
          failure={error}
          onRetry={() => setAttempt((value) => value + 1)}
        />
      </div>
    );
  if (!graph)
    return (
      <div className="tgraph-body" data-state="loading">
        <EmptyState
          size="hint"
          role="status"
          title="Loading dependencies…"
          className="flex-1"
        />
      </div>
    );
  const ticket =
    graph.nodes.find((node) => node.reference === selected) ??
    graph.nodes.find((node) => node.reference === reference);
  const limited = scopeNotice(graph, reference);
  const alone = graph.edges.length === 0;
  return (
    <div className="tgraph-body">
      {view === "graph" && alone ? (
        // One card and nothing to connect it to: say so in the canvas instead.
        <GraphCanvas
          label={`Dependencies of ${reference}`}
          notice={
            <EmptyState
              anchor="center"
              icon={<Network />}
              title="No blockers or dependents"
              description={`Nothing blocks ${reference} and nothing waits on it.`}
            />
          }
        />
      ) : view === "graph" ? (
        <Canvas
          graph={graph}
          focus={reference}
          selected={selected}
          onSelect={select}
          label={`Dependencies of ${reference}`}
          footnote={limited}
        />
      ) : (
        <TicketRows graph={graph} selected={selected} onSelect={select} />
      )}
      {ticket && (
        <SelectionPanel
          ticket={ticket}
          nodes={graph.nodes}
          version={graph}
          center={reference}
          projects={projects}
          plans={plans}
          onOpen={onOpen}
          onSelect={select}
          onCenter={onCenter}
        />
      )}
    </div>
  );
}
