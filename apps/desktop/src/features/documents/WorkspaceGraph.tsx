import { useEffect, useMemo, useRef, useState } from "react";
import type { Edge, Viewport } from "@xyflow/react";
import { ContextGraphCanvas } from "./ContextGraphCanvas";
import type { Point } from "./context-layout";
import { Button } from "@/components/ui/button";
import {
  client,
  type WorkspaceGraph as Graph,
  type WorkspaceGraphRequest,
} from "@/lib/api/client";
import "@xyflow/react/dist/style.css";
import "./context-graph.css";

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
  useEffect(() => {
    currentGraph.current = graph;
  }, [graph]);
  const observedRevision = useRef(revision);
  useEffect(() => {
    if (!active || revision === observedRevision.current) return;
    observedRevision.current = revision;
    const previous = currentGraph.current;
    if (!previous) return;
    let current = true;
    void client
      .workspaceGraph({
        ...request,
        adjacency_limit: adjacencyLimit,
        visible_ids: previous.nodes.map((node) => node.id),
        hydrate_only: true,
      })
      .then((value) => {
        if (!current || currentRequest.current !== request) return;
        setGraph({
          ...value,
          next_cursor: previous.next_cursor,
          omitted: value.omitted || previous.next_cursor !== null,
        });
      })
      .catch((reason: unknown) => {
        if (current) setError(String(reason));
      });
    return () => {
      current = false;
    };
  }, [active, revision, request, adjacencyLimit]);
  const nodes = useMemo(
    () =>
      (graph?.nodes ?? []).map((node) => {
        const tagName = graph?.node_tags[node.id];
        const hue = tagName
          ? Array.from(tagName).reduce(
              (hash, char) => (hash * 31 + char.charCodeAt(0)) % 360,
              0,
            )
          : null;
        return {
          id: node.id,
          label: `${node.kind.toUpperCase()} · ${node.label}`,
          ...(hue === null ? {} : { color: `hsl(${hue} 65% 50%)` }),
        };
      }),
    [graph],
  );
  const edges = useMemo<Edge[]>(
    () =>
      (graph?.edges ?? []).map((edge, index) => ({
        id: String(index),
        source: edge.source,
        target: edge.target,
        label: edge.kind,
      })),
    [graph],
  );
  const preview = graph?.nodes.find((node) => node.id === selected);
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
    <section
      className="context-graph-page"
      aria-label="Workspace context graph"
    >
      <div className="context-graph-heading">
        <h1>Context graph</h1>
        <Button onClick={onBack}>Back</Button>
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
        <label>
          Item type{" "}
          <select
            value={kind}
            onChange={(event) => {
              setKind(event.target.value);
              setAdjacencyLimit(3);
              setPagesLoaded(1);
            }}
          >
            <option value="">All</option>
            <option value="ticket">Tickets</option>
            <option value="document">Documents</option>
            <option value="plan">Plans</option>
          </select>
        </label>
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
        <label>
          Relationship{" "}
          <select
            value={relationship}
            onChange={(event) => {
              setRelationship(event.target.value);
              setAdjacencyLimit(3);
              setPagesLoaded(1);
            }}
          >
            <option value="">All</option>
            {[
              "blocks",
              "membership",
              "document",
              "mention",
              "activity",
              "support",
            ].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
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
          Include Activity details
        </label>
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
          />
        )}
        <aside className="context-graph-preview">
          {preview ? (
            <>
              <h2>{preview.label}</h2>
              <p>
                {preview.kind} {preview.state}{" "}
                {graph?.node_tags[preview.id]
                  ? ` · ${graph.node_tags[preview.id]}`
                  : ""}
              </p>
              <Button onClick={() => onOpen(preview)}>Open item</Button>
              <Button variant="ghost" onClick={() => onFocus(preview.id)}>
                Center on this item
              </Button>
            </>
          ) : (
            <p>Select an item to preview it.</p>
          )}
        </aside>
      </div>
      {graph?.omitted && (
        <p role="status">
          Some items or connections are omitted by bounded checks.{" "}
          {graph.omitted_groups.join(", ")}
        </p>
      )}
      {graph?.omitted_groups.length && adjacencyLimit < 12 ? (
        <Button disabled={loadingPage} onClick={() => void expandConnections()}>
          Expand connections
        </Button>
      ) : null}
      {graph?.next_cursor && (
        <Button disabled={loadingPage} onClick={() => void more()}>
          {graph.nodes.length >= 100 || pagesLoaded >= 4
            ? "Next page"
            : "Show more"}
        </Button>
      )}
      <h2>Items</h2>
      <ul className="context-graph-list">
        {graph?.nodes.map((node) => (
          <li key={node.id}>
            <button type="button" onClick={() => setSelected(node.id)}>
              {node.label}
            </button>
            {graph.edges
              .filter(
                (edge) => edge.source === node.id || edge.target === node.id,
              )
              .map((edge, index) => (
                <p key={index}>
                  {edge.kind}
                  {edge.explanation ? ` · ${edge.explanation}` : ""}
                </p>
              ))}
          </li>
        ))}
      </ul>
    </section>
  );
}
