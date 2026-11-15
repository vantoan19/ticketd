import { useEffect, useMemo, useState } from "react";
import {
  Background,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { CircleCheck, CircleDashed, LoaderCircle } from "lucide-react";
import "@xyflow/react/dist/style.css";
import { StatusDot } from "@/components/ui/status-dot";
import {
  CARD_WIDTH,
  layoutFlow,
  LEAST_ZOOM,
  TRIGGER_ID,
} from "@/features/automations/canvas-layout";
import type {
  AutomationAgent,
  AutomationRunDetail,
} from "@/features/automations/client";
import {
  CARD_ICONS,
  cardColor,
  cardName,
  openCard,
  PATH_LABEL_SHAPE,
  PATH_LABELS,
  stepCard,
  triggerCard,
  type Card,
} from "@/features/automations/flow-cards";
import { FlowView } from "@/features/automations/FlowView";
import { duration } from "@/features/chats/model";
import {
  everyStep,
  flowSteps,
  STEP_STATE_LABELS,
  stepPlaces,
  stepStates,
  type StepState,
} from "@/features/automations/runs-model";

/** A card in a run also says where the step stands, on a line of its own. */
const RUN_CARD_HEIGHT = 96;

/** The mark beside a step's status. The word is always there too. */
export function StepMark({ state }: { state: StepState }) {
  switch (state) {
    case "running":
      return (
        <LoaderCircle
          size={14}
          className="chat-spin text-status-unread"
          aria-hidden
        />
      );
    case "completed":
      return (
        <CircleCheck size={14} className="text-status-ready" aria-hidden />
      );
    case "failed":
      return <StatusDot tone="attention" />;
    case "waiting":
    case "not_run":
      return <CircleDashed size={14} aria-hidden />;
  }
}

/** How long a step has been running, counted here; the name of the step does not tick. */
function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span aria-hidden="true">
      {" "}
      · {duration(now - new Date(since).getTime())}
    </span>
  );
}

type RunCardData = {
  card: Card;
  /** Where the step is on its path; undefined for the trigger. */
  place: string | undefined;
  /** When the step started, while it is running. */
  since: string | undefined;
  /** null for the trigger, which has no status. */
  state: StepState | null;
  selected: boolean;
  onSelect: (id: string) => void;
};

function RunCardNode({ data }: NodeProps<Node<RunCardData>>) {
  const { card, place, state, since, selected, onSelect } = data;
  const Icon = CARD_ICONS[card.icon];
  const label = state && STEP_STATE_LABELS[state];
  const name = [cardName(card), place, label].filter(Boolean).join(", ");
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div
        className="flow-card"
        data-kind={cardColor(card)}
        data-selected={selected || undefined}
        data-run={state ?? undefined}
      >
        <button
          type="button"
          className="flow-card-main nodrag nopan"
          aria-label={name}
          aria-pressed={selected}
          data-flow-card={card.id}
          onClick={() => openCard(card.id, selected, onSelect)}
        >
          <span className="flow-card-icon">
            <Icon size={16} aria-hidden />
          </span>
          <span className="flow-card-text">
            <span className="flow-card-kind">{card.kind}</span>
            <span className="flow-card-title">{card.shown ?? card.title}</span>
            {card.detail && (
              <span className="flow-card-detail">{card.detail}</span>
            )}
            {state && (
              <span className="flow-card-status">
                <StepMark state={state} />
                {state === "failed" ? <strong>{label}</strong> : label}
                {since && <Elapsed since={since} />}
              </span>
            )}
          </span>
        </button>
      </div>
      {/* The line to the next step leaves the bottom; a failure path, the side. */}
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
      <Handle
        id="failure"
        type="source"
        position={Position.Right}
        isConnectable={false}
      />
    </>
  );
}

const nodeTypes = { card: RunCardNode };

/**
 * What a run did, on the canvas its Automation is built on: every step of the
 * definition the run executes with where it stands, the steps it did not reach
 * dashed, and the lines it followed marked. Nothing here can be changed.
 */
export function RunCanvas({
  run,
  agents,
  only,
  selected,
  onSelect,
}: {
  run: AutomationRunDetail;
  agents: AutomationAgent[];
  /** The line the conditions add to the trigger's card. */
  only?: string | undefined;
  /** The card whose panel is open: a step's id, or the trigger's. */
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const { nodes, edges, ran } = useMemo(() => {
    const { trigger, steps } = run.definition;
    const states = stepStates(run);
    const cards = new Map([
      [TRIGGER_ID, triggerCard(trigger, only)],
      ...everyStep(steps).map(
        (step) => [step.id, stepCard(step, agents)] as const,
      ),
    ]);
    const layout = layoutFlow(flowSteps(steps), RUN_CARD_HEIGHT);
    const places = stepPlaces(steps);
    const nodes: Node[] = layout.items.flatMap((item) => {
      const card = cards.get(item.id);
      if (item.kind !== "card" || !card) return [];
      return {
        id: item.id,
        type: "card",
        position: { x: item.x, y: item.y },
        width: CARD_WIDTH,
        height: RUN_CARD_HEIGHT,
        data: {
          card,
          place: places.get(item.id),
          state: states.get(item.id) ?? null,
          since: run.steps.find(
            (step) => step.step_id === item.id && step.status === "running",
          )?.started_at,
          selected: item.id === selected,
          onSelect,
        } satisfies RunCardData,
      };
    });
    const reached = (id: string) => {
      const state = states.get(id);
      return state !== undefined && state !== "waiting" && state !== "not_run";
    };
    const edges: Edge[] = layout.edges
      // A read-only canvas has no + to end a path on.
      .filter((edge) => cards.has(edge.target))
      .map(({ id, source, target, path }) => ({
        id,
        source,
        target,
        type: path ? "smoothstep" : "straight",
        focusable: false,
        ...(path === "failure" && { sourceHandle: "failure" }),
        ...(path && { label: PATH_LABELS[path], ...PATH_LABEL_SHAPE }),
        className: [
          path === "yes" && "flow-edge-yes",
          path === "failure" && "flow-edge-failure",
          reached(target) ? "flow-edge-taken" : "flow-edge-idle",
        ]
          .filter(Boolean)
          .join(" "),
      }));
    // What a run is opened on: the trigger and the steps it reached.
    const ran = nodes
      .map((node) => node.id)
      .filter((id) => id === TRIGGER_ID || reached(id));
    return { nodes, edges, ran };
  }, [run, agents, only, selected, onSelect]);
  return (
    <div className="flow-canvas">
      <ReactFlowProvider>
        <ReactFlow
          aria-label="Steps"
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          // As far out as the zoom control goes, for an overview.
          minZoom={LEAST_ZOOM}
          maxZoom={1.5}
          panOnScroll
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          zoomOnDoubleClick={false}
          deleteKeyCode={null}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
        </ReactFlow>
        {/* A run's steps never change, so only the canvas's size refits it. */}
        <FlowView shape="" selected={selected} start={ran} />
      </ReactFlowProvider>
    </div>
  );
}
