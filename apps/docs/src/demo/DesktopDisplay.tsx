import { useLayoutEffect, useRef, type Dispatch } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CircleCheck,
  FileText,
  Inbox,
  NotebookText,
  PanelTop,
  Waypoints,
} from "lucide-react";
import { StatusDot } from "@desktop/components/ui/status-dot";
import { Reference } from "@desktop/components/ui/reference";
import { StatusIcon } from "@desktop/features/tickets/StatusIcon";
import { PlanRing, PlanSplitBar } from "@desktop/features/plans/PlanProgress";
import {
  demoTickets,
  planName,
  planCounts,
  specification,
  specTitle,
  featureRef,
} from "./workspace";
import { entriesAt } from "./inbox-model";
import { DemoInbox } from "./DemoInbox";
import { focusWorkspaceControl } from "./focus";
import { Board } from "./Board";
import { TicketDetail } from "./TicketDetail";
import { WorkspaceTitle } from "./WorkspaceTitle";
import { useHydrated } from "../components/useHydrated";
import { PlanFlow } from "./PlanFlow";
import type { DemoAction, DemoState, Pane } from "./state";
import "virtual:desktop-tokens.css";
import "./desktop-display.css";

export function DesktopDisplay({
  state,
  dispatch,
}: {
  state: DemoState;
  dispatch: Dispatch<DemoAction>;
}) {
  const hydrated = useHydrated();
  const { stage, pane, planView, ticket: reference } = state,
    tickets = demoTickets(stage),
    counts = planCounts(tickets);
  const ticket = tickets.find((t) => t.reference === reference);
  const ready = tickets.filter((t) => t.availability === "Ready"),
    isPlan = pane === "plan";
  const entries = entriesAt(stage);
  const unread = entries.filter(
    (entry) => !state.readEntries.includes(entry.id),
  ).length;
  const needsReview = stage === 2;

  const display = useRef<HTMLDivElement>(null);
  const returnControl = useRef<string | null>(null);
  const nextFocus = useRef<string | null>(null);

  // Changing a pane replaces its controls. Carry keyboard focus into the ticket
  // and back to the same row, even after reading has changed its accessible name.
  useLayoutEffect(() => {
    if (!nextFocus.current) return;
    const target = Array.from(
      display.current?.querySelectorAll<HTMLElement>("[data-demo-control]") ??
        [],
    ).find(
      (item) =>
        item.dataset.demoControl === nextFocus.current &&
        item.getClientRects().length,
    );
    if (target && display.current)
      focusWorkspaceControl(target, display.current);
    nextFocus.current = null;
  }, [state]);
  function open(ref: string, from = ref) {
    if (!reference) returnControl.current = from;
    nextFocus.current = "back-to-workspace";
    dispatch({ type: "ticket", reference: ref });
  }
  function back() {
    nextFocus.current = returnControl.current;
    dispatch({ type: "back" });
  }
  function view(pane: Pane, focus: string | null = null) {
    nextFocus.current = focus;
    dispatch({ type: "pane", pane });
  }
  function pickWorkspace(pane: Pane) {
    view(pane, pane === "spec" ? "spec-back" : "workspace-picker");
  }
  const sidebarItems = [
    {
      pane: "inbox",
      title: "Inbox",
      icon: <Inbox size={14} />,
      count: needsReview ? 1 : null,
      tone: needsReview ? "attention" : unread ? "unread" : null,
      suffix: needsReview
        ? "entry needs you"
        : unread
          ? `${unread} unread`
          : "",
    },
    {
      pane: "ready",
      title: "Ready",
      icon: <CircleCheck size={14} />,
      count: ready.length || null,
      tone: null,
      suffix: ready.length ? (ready.length === 1 ? "ticket" : "tickets") : "",
    },
  ] as const;
  return (
    <div
      className="desktop-display"
      ref={display}
      data-stage={stage}
      inert={!hydrated}
    >
      <div className="demo-workspace">
        <nav className="demo-sidebar" aria-label="Demonstration workspace">
          <strong>ticketd</strong>
          {sidebarItems.map((item) => (
            <button
              key={item.pane}
              type="button"
              aria-pressed={pane === item.pane}
              onClick={() => view(item.pane)}
            >
              {item.icon}
              {item.title}{" "}
              {(item.count !== null || item.tone) && (
                <small>
                  {item.tone && <StatusDot tone={item.tone} size={6} />}
                  {item.count}
                </small>
              )}{" "}
              <span className="sr-only">{item.suffix}</span>
            </button>
          ))}
          <span className="sidebar-group">Plans</span>
          <button
            type="button"
            aria-pressed={isPlan}
            onClick={() => view("plan")}
          >
            <PlanRing name={planName} counts={counts} size={16} />
            <span>{planName}</span>
          </button>
          <span className="sidebar-group">Context</span>
          <button
            type="button"
            aria-pressed={pane === "spec"}
            onClick={() => view("spec")}
          >
            <NotebookText size={14} />
            Documents
          </button>
        </nav>
        <div className="demo-main">
          {ticket ? (
            <TicketDetail
              key={ticket.reference}
              ticket={ticket}
              stage={stage}
              open={open}
              back={back}
              move={(stage) => {
                nextFocus.current = stage === 2 ? "review" : featureRef;
                dispatch({ type: "step", stage });
              }}
            />
          ) : isPlan ? (
            <>
              <div className="demo-pane-title">
                <div>
                  <PlanRing name={planName} counts={counts} size={16} />
                  <WorkspaceTitle pane={pane} view={pickWorkspace} />
                  <span className="demo-count">{tickets.length}</span>
                </div>
                <div role="group" aria-label="Plan view" className="demo-views">
                  <button
                    type="button"
                    aria-pressed={planView === "board"}
                    onClick={() =>
                      dispatch({ type: "plan-view", view: "board" })
                    }
                  >
                    <PanelTop size={12} />
                    Board
                  </button>
                  <button
                    type="button"
                    aria-pressed={planView === "flow"}
                    onClick={() =>
                      dispatch({ type: "plan-view", view: "flow" })
                    }
                  >
                    <Waypoints size={12} />
                    Flow
                  </button>
                </div>
              </div>
              <div className="demo-plan-summary">
                <button
                  className="demo-spec-link"
                  data-demo-control="spec-link"
                  onClick={() => view("spec", "spec-back")}
                  type="button"
                >
                  <FileText size={12} />
                  {specTitle}
                </button>
                <span>
                  <PlanSplitBar name={planName} counts={counts} decorative />
                  {counts.done} of {tickets.length} done
                </span>
              </div>
              {planView === "flow" ? (
                <PlanFlow tickets={tickets} onOpen={open} />
              ) : (
                <Board
                  column={state.boardColumn}
                  tickets={tickets}
                  chooseColumn={(status) =>
                    dispatch({ type: "column", status })
                  }
                  onOpen={open}
                />
              )}
            </>
          ) : pane === "inbox" ? (
            <DemoInbox
              entries={entries}
              stage={stage}
              readEntries={state.readEntries}
              title={<WorkspaceTitle pane="inbox" view={pickWorkspace} />}
              markRead={() =>
                dispatch({
                  type: "read",
                  ids: entries.map((entry) => entry.id),
                })
              }
              open={(id) => {
                dispatch({ type: "read", ids: [id] });
                open(featureRef, id);
              }}
            />
          ) : pane === "ready" ? (
            <>
              <div className="demo-pane-title">
                <WorkspaceTitle pane="ready" view={pickWorkspace} />
              </div>
              <div className="demo-ready-list">
                {ready.length ? (
                  ready.map((t) => (
                    <button
                      type="button"
                      key={t.reference}
                      data-demo-control={t.reference}
                      onClick={() => open(t.reference)}
                    >
                      <StatusIcon status={t.status} decorative size={14} />
                      <Reference>{t.reference}</Reference> {t.title}
                    </button>
                  ))
                ) : (
                  <p>There are no ready tickets in this Plan.</p>
                )}
              </div>
            </>
          ) : (
            <div className="demo-detail">
              <button
                className="detail-back"
                data-demo-control="spec-back"
                type="button"
                onClick={() => view("plan", "spec-link")}
              >
                <ArrowLeft size={14} />
                Back to Plan
              </button>
              <div className="demo-detail-meta">
                <FileText size={14} />
                Document · Plan spec
              </div>
              <h3>{specTitle}</h3>
              <p>{specification}</p>
              <button
                type="button"
                className="demo-inline"
                data-demo-control="linked-ticket"
                onClick={() => open(featureRef, "linked-ticket")}
              >
                Linked ticket {featureRef} <ArrowRight size={13} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
