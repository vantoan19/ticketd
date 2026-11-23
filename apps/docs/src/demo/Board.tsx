import { Button } from "@desktop/components/ui/button";
import { Reference } from "@desktop/components/ui/reference";
import { StatusIcon } from "@desktop/features/tickets/StatusIcon";
import {
  featureRef,
  planName,
  stages,
  type DemoTicket,
  type Status,
} from "./workspace";

export function Board({
  column,
  tickets,
  chooseColumn,
  onOpen,
}: {
  column: Status;
  tickets: DemoTicket[];
  chooseColumn: (status: Status) => void;
  onOpen: (reference: string) => void;
}) {
  return (
    <>
      <div className="phone-board-tabs" role="group" aria-label="Board columns">
        {stages.map(({ status }) => (
          <button
            key={status}
            type="button"
            aria-pressed={column === status}
            onClick={() => chooseColumn(status)}
          >
            {status}
            <span>{tickets.filter((t) => t.status === status).length}</span>
          </button>
        ))}
      </div>
      <div
        className="demo-board"
        role="region"
        aria-label={planName + " Plan board"}
        tabIndex={0}
      >
        {stages.map(({ status }) => {
          const members = tickets
            .filter((t) => t.status === status)
            .sort(
              (a, b) =>
                Number(b.reference === featureRef) -
                Number(a.reference === featureRef),
            );
          return (
            <div
              className="demo-column"
              key={status}
              data-pocket-visible={status === column}
              aria-label={status}
              role="group"
            >
              <div className="demo-column-label">
                <StatusIcon status={status} size={13} decorative />
                {status}
                <span>{members.length}</span>
              </div>
              {members.map((t) => (
                <Button
                  key={t.reference}
                  data-demo-control={t.reference}
                  variant="card"
                  size="card"
                  className="demo-card"
                  data-featured={t.reference === featureRef || undefined}
                  onClick={() => {
                    chooseColumn(status);
                    onOpen(t.reference);
                  }}
                >
                  <span className="demo-ref">
                    <StatusIcon status={t.status} size={12} decorative />
                    <Reference>{t.reference}</Reference>
                  </span>{" "}
                  <span className="demo-ticket-title">{t.title}</span>{" "}
                  <span className="demo-blocker">
                    {t.blocker
                      ? "Blocked by " + t.blocker
                      : t.reference === "T-LG14"
                        ? "Subticket of " + featureRef
                        : "No project"}
                  </span>
                </Button>
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
}
