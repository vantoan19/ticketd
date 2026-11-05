import { useEffect, useMemo, useRef, useState } from "react";
import type { Viewport } from "@xyflow/react";
import { ContextGraphCanvas } from "./ContextGraphCanvas";
import { GraphLegend } from "./GraphLegend";
import { connectionRows, edgeLabels, flowEdges, kindNames } from "./graph-text";
import type { Point } from "./context-layout";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  client,
  type WorkspaceGraph as Graph,
  type WorkspaceGraphRequest,
} from "@/lib/api/client";
import "@xyflow/react/dist/style.css";
import "./context-graph.css";

// Radix Select items cannot have an empty value.
const ALL = "__all__";

export function WorkspaceGraph({
  active,
  revision,
  onBack,
  onFocus,
  onOpen,
}: {
  active: boolean;
  revision: number;
  onBack: () => void;
  onFocus: (id: string) => void;
  onOpen: (node: Graph["nodes"][number]) => void;
}) {
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("");
  const [tag, setTag] = useState("");
  const [relationship, setRelationship] = useState("");
  const [includeDetails, setIncludeDetails] = useState(false);
  const [adjacencyLimit, setAdjacencyLimit] = useState(3);
  const cursors = useRef<(string | null)[]>([null]);
  const [pagesLoaded, setPagesLoaded] = useState(1);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loadingPage, setLoadingPage] = useState(false);
  const [fit, setFit] = useState(true);
  const [positions, setPositions] = useState<Record<string, Point>>({});
  const [viewport, setViewport] = useState<Viewport>({
    x: 100,
    y: 100,
    zoom: 0.8,
  });
  const request = useMemo<WorkspaceGraphRequest>(
    () => ({
      cursor: null,
      search: search || null,
      kind: kind || null,
      tag: tag || null,
      relationship: relationship || null,
      include_details: includeDetails,
      adjacency_limit: 3,
      visible_ids: [],
      hydrate_only: false,
    }),
    [search, kind, tag, relationship, includeDetails],
  );
  const currentRequest = useRef(request);
  useEffect(() => {
    currentRequest.current = request;
    cursors.current = [null];
    let active = true;
    void client
      .workspaceGraph(request)
      .then((value) => {
        if (active) {
          setGraph(value);
          setFit(true);
          setError("");
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, [request]);
  const currentGraph = useRef(graph);
  // Bumped whenever the shown pages change, so a slower refresh can tell its
  // snapshot of them is stale and must not overwrite newer pages.
  const graphVersion = useRef(0);
  useEffect(() => {
    currentGraph.current = graph;
    graphVersion.current += 1;
  }, [graph]);
  const observedRevision = useRef(revision);
  useEffect(() => {
    if (!active || revision === observedRevision.current) return;
    observedRevision.current = revision;
    if (!currentGraph.current) return;
    let current = true;
    async function hydrate(attempts: number) {
      const previous = currentGraph.current;
      if (!previous) return;
      const version = graphVersion.current;
      try {
        const value = await client.workspaceGraph({
          ...request,
          adjacency_limit: adjacencyLimit,
          visible_ids: previous.nodes.map((node) => node.id),
          hydrate_only: true,
        });
        if (!current || currentRequest.current !== request) return;
        if (graphVersion.current !== version) {
          // Pages were loaded meanwhile; refresh those instead of replacing them.
          if (attempts > 0) await hydrate(attempts - 1);
          return;
        }
        setGraph({
          ...value,
          next_cursor: previous.next_cursor,
          omitted: value.omitted || previous.next_cursor !== null,
        });
      } catch (reason: unknown) {
        if (current) setError(String(reason));
      }
    }
    void hydrate(2);
    return () => {
      current = false;
    };
  }, [active, revision, request, adjacencyLimit]);
  const nodes = useMemo(
    () =>
      (graph?.nodes ?? []).map((node) => ({
        id: node.id,
        label: `${kindNames[node.kind].toUpperCase()} · ${node.label}${node.trashed ? " (Trash)" : ""}`,
      })),
    [graph],
  );
  const edges = useMemo(() => flowEdges(graph?.edges ?? []), [graph]);
  const preview = graph?.nodes.find((node) => node.id === selected);
  const filtered = !!(search || kind || tag || relationship);
  function clearFilters() {
    setSearch("");
    setKind("");
    setTag("");
    setRelationship("");
    setAdjacencyLimit(3);
    setPagesLoaded(1);
  }
  const more = async () => {
    if (!graph?.next_cursor || loadingPage) return;
    setLoadingPage(true);
    const advance = pagesLoaded >= 4 || graph.nodes.length >= 100;
    try {
      const page = await client.workspaceGraph({
        ...request,
        cursor: graph.next_cursor,
        adjacency_limit: adjacencyLimit,
        visible_ids: advance ? [] : graph.nodes.map((node) => node.id),
      });
      if (currentRequest.current !== request) return;
      if (advance) {
        cursors.current = [graph.next_cursor];
        setPagesLoaded(1);
      } else {
        cursors.current.push(graph.next_cursor);
        setPagesLoaded((count) => count + 1);
      }
      setGraph(page);
    } catch (reason: unknown) {
      setError(String(reason));
    } finally {
      setLoadingPage(false);
    }
  };
  const expandConnections = async () => {
    if (loadingPage || !graph) return;
    const limit = Math.min(adjacencyLimit * 2, 12);
    setLoadingPage(true);
    try {
      const page = await client.workspaceGraph({
        ...request,
        adjacency_limit: limit,
        visible_ids: graph.nodes.map((node) => node.id),
        hydrate_only: true,
      });
      if (currentRequest.current !== request) return;
      setGraph({
        ...page,
        next_cursor: graph.next_cursor,
        omitted: page.omitted || graph.next_cursor !== null,
      });
      setAdjacencyLimit(limit);
    } catch (reason: unknown) {
      setError(String(reason));
    } finally {
      setLoadingPage(false);
    }
  };
  return (
    <section className="context-graph-page" aria-label="Workspace graph">
      <div className="context-graph-heading">
        <h1>Workspace graph</h1>
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
      </div>
      <div className="context-graph-toolbar">
        <label>
          Search{" "}
          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setAdjacencyLimit(3);
              setPagesLoaded(1);
            }}
          />
        </label>
        <div className="context-graph-select">
          <span id="graph-kind-label">Item type</span>
          <Select
            value={kind || ALL}
            onValueChange={(value) => {
              setKind(value === ALL ? "" : value);
              setAdjacencyLimit(3);
              setPagesLoaded(1);
            }}
          >
            <SelectTrigger size="sm" aria-labelledby="graph-kind-label">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All</SelectItem>
              <SelectItem value="ticket">Tickets</SelectItem>
              <SelectItem value="document">Documents</SelectItem>
              <SelectItem value="plan">Plans</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <label>
          Tag{" "}
          <input
            value={tag}
            onChange={(event) => {
              setTag(event.target.value);
              setAdjacencyLimit(3);
              setPagesLoaded(1);
            }}
          />
        </label>
        <div className="context-graph-select">
          <span id="graph-relationship-label">Relationship</span>
          <Select
            value={relationship || ALL}
            onValueChange={(value) => {
              setRelationship(value === ALL ? "" : value);
              setAdjacencyLimit(3);
              setPagesLoaded(1);
            }}
          >
            <SelectTrigger size="sm" aria-labelledby="graph-relationship-label">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All</SelectItem>
              {[
                "blocks",
                "membership",
                "document",
                "mention",
                "activity",
                "support",
                "subticket",
                "related",
                "discovered",
              ].map((value) => (
                <SelectItem key={value} value={value}>
                  {edgeLabels[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <label>
          <input
            type="checkbox"
            checked={includeDetails}
            onChange={(event) => {
              setIncludeDetails(event.target.checked);
              setAdjacencyLimit(3);
              setPagesLoaded(1);
            }}
          />{" "}
          Include update details
        </label>
        {filtered && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="context-graph-main">
        {active && (
          <ContextGraphCanvas
            nodes={nodes}
            edges={edges}
            selected={selected}
            positions={positions}
            onPositions={setPositions}
            viewport={viewport}
            onViewport={setViewport}
            onSelect={setSelected}
            onError={setError}
            fit={fit}
            onFitted={() => setFit(false)}
          />
        )}
        <aside className="context-graph-preview">
          {preview ? (
            <>
              <p>{kindNames[preview.kind]}</p>
              <h2>{preview.label}</h2>
              <p>
                {preview.state}
                {preview.trashed ? " · Trashed" : ""}
                {graph?.node_tags[preview.id]
                  ? ` · Tag: ${graph.node_tags[preview.id]}`
                  : ""}
              </p>
              <Button onClick={() => onOpen(preview)}>Open item</Button>
              <Button variant="outline" onClick={() => onFocus(preview.id)}>
                Context graph
              </Button>
            </>
          ) : (
            <p>Select an item to preview it.</p>
          )}
        </aside>
      </div>
      <div className="context-graph-toolbar">
        <GraphLegend />
      </div>
      {graph && graph.nodes.length === 0 && !graph.next_cursor ? (
        <p role="status" className="context-graph-status">
          {filtered ? "No items match these filters." : "Nothing to show yet."}{" "}
          {kind && relationship
            ? "A connection to an item of another type is not shown while Item type is set. "
            : ""}
          {filtered && (
            <Button variant="outline" size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          )}
        </p>
      ) : (
        graph && (
          <p role="status" className="context-graph-status">
            {relationship && graph.nodes.length === 0
              ? "No connected items on this page"
              : relationship
                ? `Showing ${graph.nodes.length} connected ${graph.nodes.length === 1 ? "item" : "items"}`
                : `Showing ${graph.nodes.length} of ${graph.total} ${graph.total === 1 ? "item" : "items"}`}{" "}
            · {graph.edges.length}{" "}
            {graph.edges.length === 1 ? "connection" : "connections"}
            {graph.omitted_groups.length > 0 && adjacencyLimit < 12 && (
              <>
                {" · "}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={loadingPage}
                  onClick={() => void expandConnections()}
                >
                  Show more connections
                </Button>
              </>
            )}
            {graph.omitted_groups.length > 0 && adjacencyLimit >= 12 && (
              <> · Some connections are hidden; open an item to see all</>
            )}
            {graph.next_cursor && (
              <>
                {" · "}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={loadingPage}
                  onClick={() => void more()}
                >
                  {graph.nodes.length >= 100 || pagesLoaded >= 4
                    ? "Next page"
                    : "Load more"}
                </Button>
              </>
            )}
          </p>
        )
      )}
      <h2>Items</h2>
      <ul className="context-graph-list">
        {graph?.nodes.map((node) => (
          <li key={node.id}>
            <button type="button" onClick={() => setSelected(node.id)}>
              {node.label}
              {node.trashed ? " (Trash)" : ""}
            </button>
            {connectionRows(node.id, graph).map((row) => (
              <p key={row.key}>
                <strong>{edgeLabels[row.kind] ?? row.kind}</strong> · {row.text}
              </p>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}
