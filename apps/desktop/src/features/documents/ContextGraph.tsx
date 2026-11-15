import { useEffect, useMemo, useRef, useState } from "react";
import { type Viewport } from "@xyflow/react";
import { Unlink } from "lucide-react";
import "@xyflow/react/dist/style.css";
import { Button } from "@/components/ui/button";
import { Count } from "@/components/ui/count";
import { EmptyState } from "@/components/ui/empty-state";
import { FailureAlert, FailureState } from "@/components/ui/failure-alert";
import {
  GraphPanel,
  GraphPanelActions,
  GraphPanelHead,
  GraphPanelSection,
} from "@/components/ui/graph-kit";
import { PaneHeader, ReturnCrumb } from "@/components/ui/list-header";
import { Pager } from "@/components/ui/pager";
import { Reference } from "@/components/ui/reference";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { DependencyView } from "@/features/tickets/DependencyGraph";
import {
  client,
  type ContextGraph as Graph,
  type Project,
} from "@/lib/api/client";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import type { Plan } from "@/lib/api/plans";
import { useWorkspaceChange } from "@/lib/workspace-change";
import { ContextGraphCanvas } from "./ContextGraphCanvas";
import type { Point } from "./context-layout";
import { layoutFailure } from "./graph-failure";
import {
  cardParts,
  flowEdges,
  kindNames,
  labelledConnections,
  MAP_LIMIT,
  nodeAriaLabel,
  openLabel,
  passageBetween,
  opensAsMap,
  statusOf,
  stateLine,
} from "./graph-text";
import { KindIcon } from "./KindIcon";
import { GraphItemRow } from "./GraphItemRow";
import "./context-graph.css";

const GROUP_PAGE = 10;

type GraphNode = Graph["nodes"][number];

/**
 * The graph around one item (a ticket, Document or Plan): its connections as
 * a map or a list with the selection panel at the right, built from the
 * graph kit. For a ticket, "Dependencies" shows the tickets joined to it by
 * "blocks", with Ready and Blocked. Centring on another item keeps a way back.
 */
export function ContextGraph({
  active = true,
  origin,
  originLabel,
  dependencies: startWithDependencies = false,
  revision = 0,
  projects = [],
  plans = [],
  onBack,
  onOpen,
  onOpenTicket,
}: {
  active?: boolean;
  origin: string;
  /** What Back returns to once the history is empty; defaults to the item the graph was opened from. */
  originLabel?: string;
  /** Opens on the ticket's dependencies instead of all its connections. */
  dependencies?: boolean;
  revision?: number;
  projects?: Project[];
  plans?: Plan[];
  /** Gets the item the graph was opened from, so Back can return to it. */
  onBack: (origin: GraphNode | null) => void;
  onOpen: (node: GraphNode) => void;
  /** Opens a ticket named only by its reference (from the dependencies). */
  onOpenTicket?: (reference: string) => void;
}) {
  const changeVersion = useWorkspaceChange();
  const [center, setCenter] = useState(origin);
  const [selected, setSelected] = useState<string | null>(null);
  const [includeDetails, setIncludeDetails] = useState(false);
  const [dependencies, setDependencies] = useState(startWithDependencies);
  const [dependencyView, setDependencyView] = useState<"graph" | "list">(
    "graph",
  );
  const [dependencyCount, setDependencyCount] = useState<number | null>(null);
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const [pages, setPages] = useState<
    { anchor: string; group: number; offset: number }[]
  >([]);
  const [positions, setPositions] = useState<Record<string, Point>>({});
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [history, setHistory] = useState<
    {
      center: string;
      /** What Back names: the item that was centred when the view was left. */
      label: string;
      selected: string | null;
      includeDetails: boolean;
      dependencies: boolean;
      expandedIds: string[];
      pages: { anchor: string; group: number; offset: number }[];
      positions: Record<string, Point>;
      viewport: Viewport;
    }[]
  >([]);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [fit, setFit] = useState(true);
  // Set by Center: put this card in the middle of the view at the current zoom.
  const [centerOn, setCenterOn] = useState<string | null>(null);
  // Centering and going back unmount the control that had focus.
  const restoreFocus = useRef(false);
  const previewHeading = useRef<HTMLHeadingElement | null>(null);
  // The item this graph was opened from; centring elsewhere does not change it.
  const [originNode, setOriginNode] = useState<GraphNode | null>(null);
  const [error, setError] = useState<FailureDescription | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Bumped by Retry after a layout failure: a new canvas lays the graph out again.
  const [layoutRun, setLayoutRun] = useState(0);
  const [layoutError, setLayoutError] = useState<FailureDescription | null>(
    null,
  );
  // Every change (token, centre, expansion) starts a request; only the newest
  // request's answer is applied, so a slow older answer never hides a newer one.
  const latestRequest = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!active) return;
    const request = ++latestRequest.current;
    void client
      .contextGraphExpanded(center, includeDetails, expandedIds, pages)
      .then((value) => {
        if (!mounted.current || request !== latestRequest.current) return;
        setGraph(value);
        if (center === origin)
          setOriginNode(
            value.nodes.find((node) => node.id === value.center) ?? null,
          );
        // An expansion or page whose item is no longer shown has nothing to expand.
        const shown = new Set(value.nodes.map((node) => node.id));
        setExpandedIds((ids) =>
          ids.every((id) => shown.has(id))
            ? ids
            : ids.filter((id) => shown.has(id)),
        );
        setPages((items) =>
          items.every((item) => shown.has(item.anchor))
            ? items
            : items.filter((item) => shown.has(item.anchor)),
        );
        setSelected((previous) =>
          previous && value.nodes.some((node) => node.id === previous)
            ? previous
            : value.center,
        );
        setError(null);
      })
      .catch((reason: unknown) => {
        if (mounted.current && request === latestRequest.current)
          setError(describeFailure(reason, "load the graph"));
      });
    // `attempt` reloads after Retry.
  }, [
    attempt,
    active,
    center,
    origin,
    includeDetails,
    expandedIds,
    pages,
    changeVersion,
  ]);
  useEffect(() => {
    if (graph && restoreFocus.current) {
      restoreFocus.current = false;
      previewHeading.current?.focus({ preventScroll: true });
    }
  }, [graph]);
  const centerNode = graph?.nodes.find((node) => node.id === graph.center);
  const centerLabel = centerNode?.label;
  function focus(id: string) {
    restoreFocus.current = true;
    setFit(false);
    setCenterOn(id);
    setHistory((entries) => [
      ...entries,
      {
        center,
        label:
          centerNode?.ticket_reference ??
          centerLabel ??
          (center === origin ? originLabel : undefined) ??
          "previous item",
        selected,
        includeDetails,
        dependencies,
        expandedIds,
        pages,
        positions,
        viewport,
      },
    ]);
    setGraph(null);
    setExpandedIds([]);
    setPages([]);
    setPositions({});
    setSelected(id);
    setCenter(id);
  }
  function back() {
    const previous = history.at(-1);
    if (!previous) {
      onBack(originNode);
      return;
    }
    restoreFocus.current = true;
    // Back returns to the exact view that was left, not a fresh fit.
    setFit(false);
    setCenterOn(null);
    setHistory((entries) => entries.slice(0, -1));
    setGraph(null);
    setExpandedIds(previous.expandedIds);
    setPages(previous.pages);
    setPositions(previous.positions);
    setSelected(previous.selected);
    setIncludeDetails(previous.includeDetails);
    setDependencies(previous.dependencies);
    setViewport(previous.viewport);
    setCenter(previous.center);
  }
  const edges = useMemo(() => flowEdges(graph?.edges ?? []), [graph]);
  const preview = graph?.nodes.find((node) => node.id === selected);
  // A crowded neighbourhood opens as a grouped list; the map is one click away.
  // The choice holds for the whole graph session, whichever item is centred.
  const neighbours = graph ? graph.nodes.length - 1 : 0;
  const [mapChoice, setMapChoice] = useState<boolean | null>(null);
  const tooDense = neighbours > MAP_LIMIT;
  // The automatic map/list choice is made once per centre and kept, so expanding
  // (or coming Back to that centre) must not flip the view.
  const [autoChoices, setAutoChoices] = useState<Record<string, boolean>>({});
  if (graph && autoChoices[graph.center] === undefined)
    setAutoChoices((choices) => ({
      ...choices,
      [graph.center]: opensAsMap(neighbours, null),
    }));
  const showMap =
    neighbours <= MAP_LIMIT &&
    (mapChoice ??
      (graph ? autoChoices[graph.center] : undefined) ??
      opensAsMap(neighbours, null));
  const [shownPerKind, setShownPerKind] = useState<Record<string, number>>({});
  const hiddenDetails = !!graph?.hidden_details && !includeDetails;
  // Support connections stay hidden until update details are shown.
  const pending = (graph?.continuations ?? []).filter(
    (item) => !(item.kind === "support" && hiddenDetails),
  );
  const loadable = pending.filter((item) => item.next_offset !== null);
  const room = Math.max(0, 8 - expandedIds.length - pages.length);
  const reachedLimit =
    !!graph &&
    (graph.nodes.length >= graph.max_nodes ||
      graph.edges.length >= graph.max_edges);
  const moreExists = pending.length > 0;
  const canLoadMore = loadable.length > 0 && room > 0 && !reachedLimit;
  const nodeById = new Map((graph?.nodes ?? []).map((node) => [node.id, node]));
  // Connected items group by how they connect, named from the centre's side
  // ("Blocked by", "In Plan"); items only reached through an expansion come last.
  const groups = graph
    ? labelledConnections(graph.center, graph).map((row) => ({
        key: row.label,
        title: row.label,
        nodes: row.items.flatMap((item) => nodeById.get(item.id) ?? []),
      }))
    : [];
  const direct = new Set(
    groups.flatMap((group) => group.nodes.map((n) => n.id)),
  );
  const further = (graph?.nodes ?? []).filter(
    (node) => node.id !== graph?.center && !direct.has(node.id),
  );
  const listGroups = [
    ...groups,
    ...(further.length
      ? [{ key: "further", title: "Further connections", nodes: further }]
      : []),
  ];
  const connections = graph?.edges.length ?? 0;
  const status = graph && (
    <>
      {graph.nodes.length} {graph.nodes.length === 1 ? "item" : "items"} ·{" "}
      {connections} {connections === 1 ? "connection" : "connections"}
      {hiddenDetails ? " · Update details hidden" : ""}
      {moreExists && !canLoadMore ? " · View limit reached" : ""}
      {canLoadMore && (
        <>
          {" · "}
          <Button
            variant="link"
            size="sm"
            onClick={() =>
              setPages((previous) => [
                ...previous,
                ...loadable.slice(0, room).map((item) => ({
                  anchor: item.anchor,
                  group: item.group,
                  offset: item.next_offset!,
                })),
              ])
            }
          >
            Load more
          </Button>
        </>
      )}
    </>
  );
  const ticketReference =
    centerNode?.kind === "ticket"
      ? (centerNode.ticket_reference ?? null)
      : null;
  // Dependencies are a ticket's: for a Document or Plan the choice waits.
  const showDependencies = dependencies && !!ticketReference;
  const view = showDependencies ? dependencyView : showMap ? "graph" : "list";
  const backLabel = history.length
    ? history.at(-1)!.label
    : (originLabel ??
      originNode?.ticket_reference ??
      originNode?.label ??
      "source");
  const isolated = !!graph && neighbours === 0;
  const panel = preview && graph && (
    <GraphPanel
      label="Selected item"
      footer={
        <GraphPanelActions
          openLabel={openLabel(preview)}
          onOpen={() => onOpen(preview)}
          {...(preview.id !== graph.center && {
            onCenter: () => focus(preview.id),
          })}
        />
      }
    >
      <GraphPanelHead
        icon={<KindIcon kind={preview.kind} status={statusOf(preview)} />}
        eyebrow={
          cardParts(preview).ref ? (
            <Reference>{cardParts(preview).ref}</Reference>
          ) : (
            kindNames[preview.kind]
          )
        }
        title={cardParts(preview).title}
        caption={stateLine(preview)}
        headingRef={previewHeading}
      />
      {/* The centre's own connections are the map and the list; the panel
          lists another item's, so nothing is said twice. */}
      {preview.id === graph.center && (
        <p className="cgraph-caption" data-inline="">
          {connections} {connections === 1 ? "connection" : "connections"} shown{" "}
          {view === "graph" ? "on the map" : "in the list"}.
        </p>
      )}
      {preview.id !== graph.center &&
        labelledConnections(preview.id, graph).map((row) => (
          <GraphPanelSection
            key={row.label}
            title={row.label}
            count={row.items.length}
          >
            <ul className="cgraph-rows">
              {row.items.flatMap((item) => {
                const node = nodeById.get(item.id);
                return node
                  ? [
                      <li key={node.id}>
                        <GraphItemRow
                          node={node}
                          current={false}
                          {...(passageBetween(preview.id, node.id, graph) && {
                            caption: passageBetween(preview.id, node.id, graph),
                          })}
                          onSelect={() => setSelected(node.id)}
                        />
                      </li>,
                    ]
                  : [];
              })}
            </ul>
          </GraphPanelSection>
        ))}
      {preview.id !== graph.center && (
        <div className="cgraph-expand">
          <Button
            variant="ghost"
            size="sm"
            disabled={expandedIds.includes(preview.id) || room === 0}
            onClick={() => setExpandedIds((ids) => [...ids, preview.id])}
          >
            Show its connections here
          </Button>
          {(expandedIds.includes(preview.id) || room === 0) && (
            <p>
              {expandedIds.includes(preview.id)
                ? "Its connections are shown."
                : "View limit reached; center on an item to explore further."}
            </p>
          )}
        </div>
      )}
    </GraphPanel>
  );
  const emptyNotice = isolated && (
    <EmptyState
      anchor="center"
      icon={<Unlink />}
      title="Nothing connected yet"
      description="Mention this item by its reference, or attach it to a ticket, to connect it."
    />
  );
  return (
    <section className="cgraph-page" aria-label="Graph">
      <PaneHeader
        leading={<ReturnCrumb origin={backLabel} onReturn={back} />}
        title="Graph"
        count={
          // The centred item, then how much is drawn: "T-FV1 · 5 tickets".
          centerNode && (
            <Count>
              <span className="cgraph-subject">
                {centerNode.ticket_reference ?? centerNode.label}
              </span>
              {showDependencies
                ? dependencyCount !== null &&
                  ` · ${dependencyCount} ${dependencyCount === 1 ? "ticket" : "tickets"}`
                : ` · ${graph!.nodes.length} ${graph!.nodes.length === 1 ? "item" : "items"}`}
            </Count>
          )
        }
        actions={
          <SegmentedControl
            aria-label="View"
            value={view}
            onValueChange={(value) =>
              showDependencies
                ? setDependencyView(value)
                : setMapChoice(value === "graph")
            }
            options={[
              {
                value: "graph",
                label: "Graph",
                disabled: !showDependencies && tooDense,
              },
              { value: "list", label: "List" },
            ]}
          />
        }
      />
      <div className="cgraph-filters">
        <SegmentedControl
          compact
          aria-label="Show"
          value={showDependencies ? "dependencies" : "all"}
          onValueChange={(value) => setDependencies(value === "dependencies")}
          options={[
            { value: "all", label: "All connections" },
            {
              value: "dependencies",
              label: "Dependencies",
              disabled: !ticketReference,
            },
          ]}
        />
        {!showDependencies && (
          <label className="cgraph-switch">
            <Switch
              aria-label="Include update details"
              checked={includeDetails}
              // Expand choices stay; ones whose item disappears are dropped
              // when the graph reloads.
              onCheckedChange={setIncludeDetails}
            />
            Update details
          </label>
        )}
      </div>
      {showDependencies && ticketReference ? (
        <DependencyView
          key={ticketReference}
          reference={ticketReference}
          revision={revision + changeVersion}
          projects={projects}
          plans={plans}
          view={dependencyView}
          onCount={setDependencyCount}
          onOpen={(reference) => {
            if (onOpenTicket) onOpenTicket(reference);
            else if (centerNode && reference === ticketReference)
              onOpen(centerNode);
          }}
          onCenter={focus}
        />
      ) : error ? (
        <div className="cgraph-body" data-state="failed">
          <FailureState
            failure={error}
            onRetry={() => setAttempt((value) => value + 1)}
          />
        </div>
      ) : (
        <div className="cgraph-body">
          {view === "graph" ? (
            active && (
              <ContextGraphCanvas
                key={layoutRun}
                nodes={
                  isolated
                    ? []
                    : (graph?.nodes ?? []).map((node) => ({
                        id: node.id,
                        label: nodeAriaLabel(node),
                        ...cardParts(node),
                        caption:
                          node.kind === "ticket"
                            ? stateLine(node)
                            : cardParts(node).caption,
                        kind: node.kind,
                        status: statusOf(node),
                      }))
                }
                edges={edges}
                selected={selected}
                positions={positions}
                onPositions={(value) => {
                  setLayoutError(null);
                  setPositions(value);
                }}
                viewport={viewport}
                onViewport={setViewport}
                onSelect={setSelected}
                onError={(details) => setLayoutError(layoutFailure(details))}
                fit={fit}
                centerOn={centerOn}
                centerId={graph?.center}
                loading={!graph}
                onFitted={() => {
                  setFit(false);
                  setCenterOn(null);
                }}
                notice={
                  layoutError ? (
                    <FailureAlert
                      size="compact"
                      failure={layoutError}
                      onRetry={() => {
                        setLayoutError(null);
                        setLayoutRun((value) => value + 1);
                      }}
                    />
                  ) : (
                    emptyNotice
                  )
                }
                footnote={!isolated && status}
              />
            )
          ) : (
            <div className="cgraph-scroll">
              {graph && !isolated && <p className="cgraph-caption">{status}</p>}
              {tooDense && (
                <p className="cgraph-caption">
                  Too many connections for a map. Focus on an item to see its
                  own.
                </p>
              )}
              {isolated && (
                <div className="cgraph-list-empty">{emptyNotice}</div>
              )}
              {listGroups.map((group) => {
                const limit = shownPerKind[group.key] ?? GROUP_PAGE;
                return (
                  <section
                    key={group.key}
                    className="cgraph-group"
                    aria-label={group.title}
                  >
                    <h3>
                      {group.title} <Count>{group.nodes.length}</Count>
                    </h3>
                    <ul className="cgraph-rows">
                      {group.nodes.slice(0, limit).map((node) => (
                        <li key={node.id}>
                          <GraphItemRow
                            node={node}
                            current={selected === node.id}
                            onSelect={() => setSelected(node.id)}
                            onFocus={() => focus(node.id)}
                          />
                        </li>
                      ))}
                    </ul>
                    {group.nodes.length > limit && (
                      <Pager
                        more={Math.min(GROUP_PAGE, group.nodes.length - limit)}
                        noun={group.title}
                        onMore={() =>
                          setShownPerKind((value) => ({
                            ...value,
                            [group.key]: limit + GROUP_PAGE,
                          }))
                        }
                      />
                    )}
                  </section>
                );
              })}
            </div>
          )}
          {panel}
        </div>
      )}
    </section>
  );
}
