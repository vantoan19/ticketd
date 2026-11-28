import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FailureState } from "@/components/ui/failure-alert";
import {
  AvailabilityMark,
  GraphNodeCard,
  GraphFlowLane,
} from "@/components/ui/graph-kit";
import { Appear, DrawnPath } from "@/components/ui/motion";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { ContextGraphNavigation } from "@/features/documents/navigation";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import type { FlowTicketMetadata } from "@/lib/api/client";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { matchesShortcut, shortcutLabel } from "@/lib/shortcuts";
import { useWorkspaceChange } from "@/lib/workspace-change";
import { flowPlanMembers, PlanMemberWindow } from "./plan-members";
import { flowLinkPath, planFlow, type FlowBox } from "./flow-model";
import "./plan-flow.css";

const names = ["Can start", "After one step", "Later"];
const captions = [
  "No open blockers",
  "One layer of blockers",
  "Longer chains or cycles",
];

/** Cascade steps between lanes (about 70ms), and from a heading to its first ticket. */
const LANE_STEPS = 3;
const FIRST_TICKET_STEPS = 2;

export function PlanFlow({
  id,
  revision,
  onOpen,
}: {
  id: string;
  revision: number;
  onOpen: (reference: string) => void;
}) {
  const [members, setMembers] = useState<FlowTicketMetadata[] | null>(null);
  const [failure, setFailure] = useState<FailureDescription | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const version = useWorkspaceChange();
  const openGraph = useContext(ContextGraphNavigation);
  const frame = useRef<HTMLDivElement>(null);
  const cards = useRef(new Map<string, HTMLButtonElement>());
  const remeasure = useRef(() => {});
  const [lines, setLines] = useState<
    { key: string; d: string; hot: boolean }[]
  >([]);
  useEffect(() => {
    let active = true;
    void flowPlanMembers(id).then(
      (value) => {
        if (active) {
          setMembers(value);
          setFailure(null);
        }
      },
      (reason) => {
        if (active) {
          setMembers(null);
          const failure = describeFailure(reason, "load this Plan’s Flow");
          setFailure(
            reason instanceof PlanMemberWindow
              ? {
                  ...failure,
                  sentence:
                    "This Plan exceeds the complete Flow window (500 tickets or 50 blockers per ticket). Use List to page its members, or open the full graph.",
                }
              : failure,
          );
        }
      },
    );
    return () => {
      active = false;
    };
  }, [id, revision, version, attempt]);
  const flow = useMemo(() => planFlow(members ?? []), [members]);
  const hasLater = Boolean(flow.lanes[2]?.length);
  const ordered = flow.lanes.flat();
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    function measure() {
      const bounds = element!.getBoundingClientRect();
      const relative = (rect: DOMRect): FlowBox => ({
        left: rect.left - bounds.left,
        right: rect.right - bounds.left,
        top: rect.top - bounds.top,
        bottom: rect.bottom - bounds.top,
      });
      const laneOf = new Map(
        flow.lanes.flatMap((lane, index) =>
          lane.map((ticket) => [ticket.reference, index] as const),
        ),
      );
      setLines(
        flow.edges.flatMap((edge) => {
          const source = cards.current
            .get(edge.blocker)
            ?.getBoundingClientRect();
          const target = cards.current
            .get(edge.dependent)
            ?.getBoundingClientRect();
          // Cycles and same-lane relationships are explained on the cards; Flow never points left.
          if (!source || !target || target.left <= source.right) return [];
          // A link that skips a lane goes around the cards of the lanes it
          // skips instead of through them.
          const skipped = flow.lanes
            .slice(
              (laneOf.get(edge.blocker) ?? 0) + 1,
              laneOf.get(edge.dependent) ?? 0,
            )
            .flat();
          const between = skipped.flatMap((ticket) => {
            const box = cards.current.get(ticket.reference);
            return box ? [relative(box.getBoundingClientRect())] : [];
          });
          return [
            {
              key: `${edge.blocker}:${edge.dependent}`,
              d: flowLinkPath(relative(source), relative(target), between),
              hot: edge.blocker === selected || edge.dependent === selected,
            },
          ];
        }),
      );
    }
    measure();
    // A card still rising into place is painted a few pixels low; measure again
    // as each one lands, before the lines (which wait for the cards) draw.
    remeasure.current = measure;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [flow, selected]);
  return (
    <section
      className="plan-flow"
      aria-label="Plan Flow"
      aria-busy={!members && !failure}
    >
      <div className="plan-flow-scroll">
        <div
          className="plan-flow-lanes"
          data-has-later={hasLater || undefined}
          ref={frame}
        >
          <svg
            className="plan-flow-edges ui-graph-flow-edges"
            aria-hidden="true"
          >
            <defs>
              <marker
                id="flow-arrow"
                markerWidth="6"
                markerHeight="6"
                refX="6"
                refY="3"
                orient="auto"
              >
                <path d="M0 0L6 3L0 6Z" />
              </marker>
              <marker
                id="flow-arrow-hot"
                markerWidth="6"
                markerHeight="6"
                refX="6"
                refY="3"
                orient="auto"
              >
                <path d="M0 0L6 3L0 6Z" />
              </marker>
            </defs>
            {lines.map((line) => (
              <DrawnPath
                key={line.key}
                data-edge={line.key}
                data-hot={line.hot || undefined}
                d={line.d}
                markerEnd={`url(#flow-arrow${line.hot ? "-hot" : ""})`}
              />
            ))}
          </svg>
          {flow.lanes.slice(0, hasLater ? 3 : 2).map((lane, index) => (
            <GraphFlowLane
              key={names[index]}
              index={index * LANE_STEPS}
              title={names[index]!}
              caption={`${captions[index]} · ${members ? lane.length : "…"}`}
            >
              {!members && !failure && (
                <div className="plan-flow-placeholder">
                  <Skeleton className="h-full w-full" />
                </div>
              )}
              {lane.map((ticket, row) => (
                <Appear
                  key={ticket.reference}
                  index={index * LANE_STEPS + FIRST_TICKET_STEPS + row}
                  onAnimationComplete={() => remeasure.current()}
                >
                  <Tooltip
                    content={`${ticket.reference}: ${ticket.title}. ${flow.reason(ticket)}. Enter to open.`}
                    shortcut={shortcutLabel("flow-open")}
                  >
                    <GraphNodeCard
                      variant="flow"
                      aria-pressed={selected === ticket.reference}
                      ref={(node) => {
                        if (node) cards.current.set(ticket.reference, node);
                        else cards.current.delete(ticket.reference);
                      }}
                      reference={ticket.reference}
                      title={ticket.title}
                      icon={<StatusIcon status={ticket.status} decorative />}
                      {...(ticket.status !== "Todo" && { meta: ticket.status })}
                      trailing={
                        <AvailabilityMark availability={ticket.availability} />
                      }
                      aria-description={flow.reason(ticket)}
                      reason={flow.reason(ticket)}
                      selected={selected === ticket.reference}
                      onClick={() => setSelected(ticket.reference)}
                      onKeyDown={(event) => {
                        if (event.metaKey || event.ctrlKey || event.altKey)
                          return;
                        if (
                          matchesShortcut(event, "flow-full-graph") &&
                          openGraph
                        ) {
                          event.preventDefault();
                          openGraph(id, { workspacePlan: id });
                        } else if (matchesShortcut(event, "flow-open")) {
                          event.preventDefault();
                          onOpen(ticket.reference);
                        } else if (matchesShortcut(event, "flow-move")) {
                          event.preventDefault();
                          const direction = [
                            "k",
                            "ArrowUp",
                            "ArrowLeft",
                          ].includes(event.key)
                            ? -1
                            : 1;
                          const next =
                            ordered[
                              Math.max(
                                0,
                                Math.min(
                                  ordered.length - 1,
                                  ordered.findIndex(
                                    (item) =>
                                      item.reference === ticket.reference,
                                  ) + direction,
                                ),
                              )
                            ];
                          if (next) {
                            setSelected(next.reference);
                            cards.current.get(next.reference)?.focus();
                          }
                        }
                      }}
                    />
                  </Tooltip>
                </Appear>
              ))}
            </GraphFlowLane>
          ))}
          {!members && !failure && (
            <span role="status" className="sr-only">
              Loading Flow…
            </span>
          )}
          {failure && (
            <div className="plan-flow-notice">
              <FailureState
                failure={failure}
                onRetry={() => setAttempt((value) => value + 1)}
              />
            </div>
          )}
          {members && !ordered.length && !failure && (
            <div className="plan-flow-notice">
              <EmptyState
                title="No open tickets in this Plan"
                description="Flow shows the work remaining. Done, Canceled and Duplicate tickets are in List."
              />
            </div>
          )}
        </div>
      </div>
      <footer className="plan-flow-footer ui-graph-flow-footer">
        <span>→ blocks</span>
        <span>
          A ticket moves left as its blockers finish.
          {flow.undrawn > 0 &&
            ` ${flow.undrawn === 1 ? "1 link inside a lane isn’t" : `${flow.undrawn} links inside a lane aren’t`} drawn; each card says what it waits on.`}
          {selected
            ? ` Selected: ${selected} and the links into and out of it.`
            : ` ${shortcutLabel("flow-move")} to select; Enter to open.`}
        </span>
        {openGraph && (
          <Tooltip
            content="Open Workspace graph filtered to this Plan"
            shortcut={shortcutLabel("flow-full-graph")}
          >
            <Button
              variant="link"
              size="sm"
              onClick={() => openGraph(id, { workspacePlan: id })}
            >
              Open the full graph
            </Button>
          </Tooltip>
        )}
      </footer>
    </section>
  );
}
