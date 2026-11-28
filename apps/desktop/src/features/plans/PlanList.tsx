import { useEffect, useMemo, useState } from "react";
import { ArchiveRestore, Layers, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { enter } from "@/components/ui/enter";
import { Count } from "@/components/ui/count";
import { EmptyState } from "@/components/ui/empty-state";
import { ManagementPage, PageHeader } from "@/components/ui/page-header";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useStatusLine } from "@/components/ui/use-status-line";
import { describeFailure } from "@/lib/api/describe-failure";
import { plansClient, type Plan } from "@/lib/api/plans";
import { emptyCopy } from "@/lib/empty-copy";
import { matchesShortcut, shortcutLabel } from "@/lib/shortcuts";
import { Tooltip } from "@/components/ui/tooltip";
import { NewPlanDialog } from "./NewPlanDialog";
import { FailureAlert, FailureState } from "@/components/ui/failure-alert";
import type { FailureDescription } from "@/lib/api/describe-failure";
import { useWorkspaceChange } from "@/lib/workspace-change";
import { PlanIndexRow, PlanIndexRowSkeleton } from "./PlanIndexRow";
import { readPlanIndexData, type PlanIndexData } from "./plan-index-data";
import "./plan-index.css";
/**
 * The Plans page (DESIGN.md section 10): a management page with "New Plan"
 * in its header, Active and Archived as one segmented choice, and one row per
 * Plan with its progress. An archived row reactivates with Undo.
 */
export function PlanList({
  plans,
  known = true,
  failure = null,
  retry,
  archived,
  onOpen,
  onArchivedChange,
  refresh,
}: {
  plans: Plan[];
  known?: boolean;
  failure?: FailureDescription | null;
  retry?: () => Promise<void>;
  archived: boolean;
  onOpen: (id: string) => void;
  /** Switches between the Active and Archived Plans. */
  onArchivedChange?: (archived: boolean) => void;
  refresh: () => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState("");
  const statusLine = useStatusLine();
  const shown = useMemo(
    () => plans.filter((item) => item.archived === archived),
    [plans, archived],
  );
  const empty = emptyCopy(archived ? "plans-archived" : "plans");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        document.querySelector(
          '[role="dialog"], [role="menu"], [role="listbox"]',
        ) ||
        (event.target instanceof Element &&
          event.target.closest(
            "input, textarea, select, [contenteditable=true]",
          ))
      )
        return;
      if (matchesShortcut(event, "new-plan")) {
        event.preventDefault();
        setCreating(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
        details: failure.details,
        ...(failure.action === "retry" && {
          action: { label: "Retry", run: () => reactivate(item) },
        }),
      });
    } finally {
      setPending("");
    }
  }

  return (
    <ManagementPage
      layout="centered"
      ownEntrance
      aria-labelledby="plan-index-heading"
    >
      <div {...enter(0)}>
        <PageHeader
          title="Plans"
          titleId="plan-index-heading"
          {...(shown.length > 0 && { count: <Count>{shown.length}</Count> })}
          lede="A Plan groups the tickets that ship together, across projects."
          actions={
            <>
              {onArchivedChange && (
                <SegmentedControl
                  aria-label="Which Plans"
                  value={archived ? "archived" : "active"}
                  onValueChange={(value) =>
                    onArchivedChange(value === "archived")
                  }
                  options={[
                    { value: "active", label: "Active" },
                    { value: "archived", label: "Archived" },
                  ]}
                />
              )}
              <Tooltip content="New Plan" shortcut={shortcutLabel("new-plan")}>
                <Button size="sm" onClick={() => setCreating(true)}>
                  <Plus data-icon="inline-start" /> New Plan
                </Button>
              </Tooltip>
            </>
          }
        />
      </div>
      {known && failure && (
        <FailureAlert
          failure={failure}
          onRetry={retry ?? refresh}
          size="compact"
        />
      )}
      {!known ? (
        failure ? (
          <FailureState failure={failure} onRetry={retry ?? refresh} />
        ) : (
          <LoadingPlans count={2} />
        )
      ) : shown.length === 0 ? (
        // "New Plan" sits in the header beside it: no second action (P9).
        <EmptyState
          icon={<Layers />}
          title={empty.title}
          description={empty.sentence}
        />
      ) : (
        <PlanIndexRows
          key={archived ? "archived" : "active"}
          plans={shown}
          archived={archived}
          onOpen={onOpen}
          pending={pending}
          reactivate={reactivate}
        />
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

function LoadingPlans({ count }: { count: number }) {
  return (
    <div role="status" aria-label="Loading Plans">
      <span className="sr-only">Loading Plans…</span>
      <ul className="plan-index-list" aria-hidden="true">
        {Array.from({ length: count }, (_, index) => (
          <li key={index}>
            <PlanIndexRowSkeleton />
          </li>
        ))}
      </ul>
    </div>
  );
}

type Rows = {
  order: string[];
  byId: Map<string, PlanIndexData>;
  failure: FailureDescription | null;
};

function PlanIndexRows({
  plans,
  archived,
  onOpen,
  pending,
  reactivate,
}: {
  plans: Plan[];
  archived: boolean;
  onOpen: (id: string) => void;
  pending: string;
  reactivate: (plan: Plan) => Promise<void>;
}) {
  const change = useWorkspaceChange();
  const [attempt, setAttempt] = useState(0);
  const [rows, setRows] = useState<Rows | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all(
      plans.map(
        async (plan) => [plan.id, await readPlanIndexData(plan)] as const,
      ),
    ).then((results) => {
      if (!live) return;
      setRows((previous) => {
        const byId = new Map(
          results.map(([id, result]) => {
            const lastGood = previous?.byId.get(id);
            return [
              id,
              "error" in result && lastGood?.counts ? lastGood : result.data,
            ];
          }),
        );
        const kept = previous?.order.filter((id) => byId.has(id)) ?? [];
        const pinned = new Set(kept);
        const arrived = plans
          .filter((plan) => !pinned.has(plan.id))
          .sort((a, b) => {
            const left = byId.get(a.id);
            const right = byId.get(b.id);
            return (
              Number((right?.counts?.in_review ?? 0) > 0) -
                Number((left?.counts?.in_review ?? 0) > 0) ||
              (Date.parse(right?.details?.updated ?? "") || 0) -
                (Date.parse(left?.details?.updated ?? "") || 0)
            );
          });
        const failed = results.find(([, result]) => "error" in result);
        return {
          order: [...kept, ...arrived.map((plan) => plan.id)],
          byId,
          failure: failed
            ? describeFailure(failed[1].error, "load Plan details")
            : null,
        };
      });
    });
    return () => {
      live = false;
    };
  }, [plans, change, attempt]);

  if (!rows) return <LoadingPlans count={Math.min(plans.length, 8)} />;
  const current = new Map(plans.map((plan) => [plan.id, plan]));
  return (
    <>
      {rows.failure && (
        <FailureAlert
          size="compact"
          failure={rows.failure}
          onRetry={() => setAttempt((value) => value + 1)}
        />
      )}
      <ul
        className="plan-index-list"
        aria-label={archived ? "Archived Plans" : "Active Plans"}
      >
        {rows.order.map((id, index) => {
          const plan = current.get(id);
          const data = rows.byId.get(id);
          if (!plan || !data) return null;
          return (
            <li key={id} {...enter(index + 1)}>
              <PlanIndexRow plan={plan} data={data} onOpen={() => onOpen(id)}>
                {archived && (
                  <span className="plan-index-action">
                    <Tooltip
                      content="Reactivate Plan"
                      shortcut={shortcutLabel("list-open")}
                    >
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending === id}
                        aria-label={`Reactivate ${plan.name}`}
                        onClick={() => void reactivate(plan)}
                      >
                        <ArchiveRestore data-icon="inline-start" />{" "}
                        <span className="plan-index-action-label">
                          Reactivate
                        </span>
                      </Button>
                    </Tooltip>
                  </span>
                )}
              </PlanIndexRow>
            </li>
          );
        })}
      </ul>
    </>
  );
}
