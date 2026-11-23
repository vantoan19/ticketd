import type { CSSProperties } from "react";
import {
  AvailabilityMark,
  GraphNodeCard,
} from "@desktop/components/ui/graph-kit";
import { StatusIcon } from "@desktop/features/tickets/StatusIcon";
import { flowLinkPath, planFlow } from "@desktop/features/plans/flow-model";
import { dependentRef, featureRef, type DemoTicket } from "./workspace";

import "./plan-flow.css";

const laneNames = ["Now", "Next", "Later"];
const captions = ["No open blockers", "Waits on Now", "Waits on Next"];
const focusChain = [featureRef, dependentRef, "T-LG10"];
// The card layout and the desktop link curves use the same row measurements.
const rowHeight = 64,
  rowGap = 5,
  rowPitch = rowHeight + rowGap;
const laneStyle = {
  "--flow-card-height": rowHeight + "px",
  "--flow-row-gap": rowGap + "px",
} as CSSProperties;
function linkInGutter(from: number, to: number) {
  const box = (left: number, index: number) => ({
    left,
    right: left,
    top: index * rowPitch,
    bottom: index * rowPitch + rowHeight,
  });
  return flowLinkPath(box(0, from), box(30, to), []);
}

/** The desktop supplies lane membership, ordering, reasons and connector curves.
 * Narrow lanes lead with the dependency chain and let visitors scroll to every ticket. */
export function PlanFlow({
  tickets,
  onOpen,
}: {
  tickets: DemoTicket[];
  onOpen: (reference: string) => void;
}) {
  const flow = planFlow(tickets);
  const card = (ticket: DemoTicket) => (
    <GraphNodeCard
      key={ticket.reference}
      data-demo-control={ticket.reference}
      variant="flow"
      reference={ticket.reference}
      title={ticket.title}
      aria-label={undefined}
      icon={<StatusIcon status={ticket.status} size={12} />}
      trailing={<AvailabilityMark availability={ticket.availability} />}
      reason={flow.reason(ticket)}
      selected={ticket.reference === featureRef}
      onClick={() => onOpen(ticket.reference)}
    />
  );
  return (
    <div
      className="demo-flow-scroll"
      tabIndex={0}
      role="region"
      aria-label="Plan dependency flow"
    >
      <div className="demo-flow" style={laneStyle}>
        {flow.lanes.map((lane, i) => (
          <div className="demo-flow-lane" key={laneNames[i]}>
            <div className="demo-lane-heading">
              {laneNames[i]}
              <span>{captions[i]}</span>
            </div>
            {lane.length > 0 && (
              <>
                <div className="flow-stack">{lane.map(card)}</div>
                <div
                  className="flow-strip"
                  role="group"
                  aria-label={laneNames[i] + " tickets"}
                  onScroll={(event) => {
                    const strip = event.currentTarget;
                    strip.toggleAttribute(
                      "data-scrolled",
                      strip.scrollLeft > 3,
                    );
                  }}
                >
                  {[...lane]
                    .sort(
                      (a, b) =>
                        Number(focusChain.includes(b.reference)) -
                        Number(focusChain.includes(a.reference)),
                    )
                    .map(card)}
                </div>
              </>
            )}
            {!lane.length && (
              <span className="demo-lane-empty">No waiting tickets</span>
            )}
            {i < 2 && (
              <svg
                className="demo-flow-links"
                aria-hidden="true"
                viewBox="0 0 30 220"
                preserveAspectRatio="none"
              >
                {flow.edges.map((edge) => {
                  const from = lane.findIndex(
                    (t) => t.reference === edge.blocker,
                  );
                  const to = flow.lanes[i + 1]!.findIndex(
                    (t) => t.reference === edge.dependent,
                  );
                  if (from < 0 || to < 0) return null;
                  const y = to * rowPitch + rowHeight / 2;
                  return (
                    <g key={edge.blocker + "-" + edge.dependent}>
                      <path d={linkInGutter(from, to)} />
                      <path
                        d={"M25 " + (y - 2.5) + " 30 " + y + " 25 " + (y + 2.5)}
                      />
                    </g>
                  );
                })}
              </svg>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
