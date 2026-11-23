import { ArrowLeft, ArrowRight, CircleCheck, GitBranch } from "lucide-react";
import { Reference } from "@desktop/components/ui/reference";
import { StatusIcon } from "@desktop/features/tickets/StatusIcon";
import {
  agentName,
  dependentRef,
  featureRef,
  report,
  type DemoTicket,
  type Stage,
} from "./workspace";

export function TicketDetail({
  ticket,
  stage,
  open,
  back,
  move,
}: {
  ticket: DemoTicket;
  stage: Stage;
  open: (reference: string) => void;
  back: () => void;
  move: (stage: Stage) => void;
}) {
  const blocker = ticket.blocker;
  const featured = ticket.reference === featureRef,
    updated = featured && stage >= 2;
  return (
    <div className="demo-detail">
      <button
        className="detail-back"
        data-demo-control="back-to-workspace"
        type="button"
        onClick={back}
      >
        <ArrowLeft size={14} />
        Back to workspace
      </button>
      <div className="demo-detail-meta">
        <Reference>{ticket.reference}</Reference>
        <StatusIcon status={ticket.status} decorative size={14} />
        {ticket.status}
        {ticket.editingAgent && <span>· {ticket.editingAgent}</span>}
      </div>
      <h3>{ticket.title}</h3>
      <p>{ticket.body}</p>
      {updated && (
        <div className="demo-report">
          <strong>Latest update · {agentName}</strong>
          <p>{report}</p>
          <div className="demo-detail-meta">
            <GitBranch size={13} />
            auth/login-limiter <CircleCheck size={13} /> Boundary tests passed
          </div>
        </div>
      )}
      {blocker && (
        <button
          className="demo-inline"
          type="button"
          onClick={() => open(blocker)}
        >
          Blocked by {blocker} <ArrowRight size={13} />
        </button>
      )}
      {featured && (
        <div className="detail-actions">
          <button
            className="demo-inline"
            type="button"
            onClick={() => open(dependentRef)}
          >
            Blocks {dependentRef} <ArrowRight size={13} />
          </button>
          <button
            type="button"
            className="demo-inline"
            onClick={() => open("T-LG14")}
          >
            Subticket T-LG14 <ArrowRight size={13} />
          </button>
          {stage < 3 && (
            <button
              className="demo-move"
              type="button"
              onClick={() => move((stage + 1) as Stage)}
            >
              {["Start work", "Send for review", "Move to Done"][stage]}{" "}
              <ArrowRight size={13} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
