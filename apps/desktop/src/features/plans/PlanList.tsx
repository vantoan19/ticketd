import { useEffect, useState } from "react";
import { ArchiveRestore, Layers, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Count } from "@/components/ui/count";
import { EmptyState } from "@/components/ui/empty-state";
import { ManagementPage, PageHeader } from "@/components/ui/page-header";
import { Progress } from "@/components/ui/progress";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Tooltip } from "@/components/ui/tooltip";
import { useStatusLine } from "@/components/ui/use-status-line";
import { client } from "@/lib/api/client";
import { describeFailure } from "@/lib/api/describe-failure";
import { plansClient, type Plan } from "@/lib/api/plans";
import { emptyCopy } from "@/lib/empty-copy";
import { NewPlanDialog } from "./NewPlanDialog";
import "./plan.css";

/** What a Plan's tickets add up to: done of those that can still be done. */
type Progressed = { done: number; counted: number };

const COUNT_FILTER = {
  query: "",
  unlinked: false,
  status: null,
  tags: [],
  availability: null,
  family: null,
  limit: 1,
  offset: 0,
};

/**
 * The Plans page (DESIGN.md section 10): a management page with "New Plan"
 * in its header, Active and Archived as one segmented choice, and one row per
 * Plan with its progress. An archived row reactivates with Undo.
 */
export function PlanList({
  plans,
  archived,
  onOpen,
  onArchivedChange,
  refresh,
}: {
  plans: Plan[];
  archived: boolean;
  onOpen: (id: string) => void;
  /** Switches between the Active and Archived Plans. */
  onArchivedChange?: (archived: boolean) => void;
  refresh: () => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState("");
  const [progress, setProgress] = useState<Record<string, Progressed>>({});
  const statusLine = useStatusLine();
  const shown = plans.filter((item) => item.archived === archived);
  const empty = emptyCopy(archived ? "plans-archived" : "plans");

  useEffect(() => {
    let active = true;
    for (const item of plans)
      void client
        .countTickets({ ...COUNT_FILTER, project: null, plan: item.id })
        .then((c) => {
          if (!active) return;
          const counted = c.total - c.canceled - c.duplicate;
          setProgress((old) => ({
            ...old,
            [item.id]: { done: c.done, counted },
          }));
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [plans]);

  async function reactivate(item: Plan) {
    setPending(item.id);
    try {
      await plansClient.change(item.id, null, false);
      await refresh();
      statusLine.show({
        message: `Reactivated ${item.name}`,
        undo: async () => {
          await plansClient.change(item.id, null, true);
          await refresh();
        },
      });
    } catch (reason) {
      const failure = describeFailure(reason, `reactivate ${item.name}`);
      statusLine.show({
        tone: "error",
        message: `${failure.title}. ${failure.sentence}`,
        ...(failure.action === "retry" && {
          action: { label: "Retry", run: () => reactivate(item) },
        }),
      });
    } finally {
      setPending("");
    }
  }

  return (
    <ManagementPage aria-labelledby="plan-index-heading">
      <PageHeader
        title="Plans"
        titleId="plan-index-heading"
        {...(shown.length > 0 && { count: <Count>{shown.length}</Count> })}
        lede="A Plan groups the tickets that ship together, across projects."
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus data-icon="inline-start" /> New Plan
          </Button>
        }
        toolbar={
          onArchivedChange && (
            <SegmentedControl
              aria-label="Which Plans"
              value={archived ? "archived" : "active"}
              onValueChange={(value) => onArchivedChange(value === "archived")}
              options={[
                { value: "active", label: "Active" },
                { value: "archived", label: "Archived" },
              ]}
            />
          )
        }
      />
      {shown.length === 0 ? (
        // "New Plan" sits in the header beside it: no second action (P9).
        <EmptyState
          icon={<Layers />}
          title={empty.title}
          description={empty.sentence}
        />
      ) : (
        <ul
          className="plan-index-list"
          aria-label={archived ? "Archived Plans" : "Active Plans"}
        >
          {shown.map((item) => {
            const counts = progress[item.id];
            return (
              <li key={item.id}>
                <button
                  type="button"
                  className="plan-index-row"
                  onClick={() => onOpen(item.id)}
                >
                  <Layers aria-hidden="true" />
                  <Tooltip content={item.name} overflowOnly>
                    <span className="plan-index-name">{item.name}</span>
                  </Tooltip>
                  <span className="plan-index-meta">
                    {counts &&
                      (counts.counted > 0 ? (
                        <>
                          <Progress
                            aria-label={`${item.name} progress`}
                            value={counts.done}
                            max={counts.counted}
                          />
                          {counts.done} of {counts.counted} done
                        </>
                      ) : (
                        "No tickets"
                      ))}
                  </span>
                </button>
                {archived && (
                  <span className="plan-index-action">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending === item.id}
                      aria-label={`Reactivate ${item.name}`}
                      onClick={() => void reactivate(item)}
                    >
                      <ArchiveRestore data-icon="inline-start" /> Reactivate
                    </Button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <NewPlanDialog
        open={creating}
        onOpenChange={setCreating}
        refresh={refresh}
        onCreated={onOpen}
      />
    </ManagementPage>
  );
}
