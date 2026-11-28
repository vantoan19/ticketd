import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
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
import { PlanIndexRow, PlanIndexRowSkeleton } from "./PlanIndexRow";
import { usePlanIndexData, type PlanIndexData } from "./plan-index-data";
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

const unknownPlanData: PlanIndexData = { counts: undefined, details: null };

type RowObservation = {
  answered: boolean;
  review: boolean;
  updated: number;
  failure: FailureDescription | null;
  retry: () => Promise<void>;
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
  const [observations, setObservations] = useState(
    () => new Map<string, RowObservation>(),
  );
  const observe = useCallback((id: string, row: RowObservation) => {
    setObservations((previous) => new Map(previous).set(id, row));
  }, []);
  const [pinnedOrder, setPinnedOrder] = useState<string[]>([]);
  const current = new Map(plans.map((plan) => [plan.id, plan] as const));
  const pinned = new Set(pinnedOrder);
  const arrived = plans.filter((plan) => !pinned.has(plan.id));
  const awaitingArrivals = arrived.some(
    (plan) => !observations.get(plan.id)?.answered,
  );
  if (!awaitingArrivals && arrived.length) {
    arrived.sort((a, b) => {
      const left = observations.get(a.id);
      const right = observations.get(b.id);
      return (
        Number(right?.review ?? false) - Number(left?.review ?? false) ||
        (right?.updated ?? 0) - (left?.updated ?? 0)
      );
    });
    setPinnedOrder([...pinnedOrder, ...arrived.map((plan) => plan.id)]);
  }
  const loading = pinnedOrder.length === 0 && awaitingArrivals;
  const order = [
    ...pinnedOrder.filter((id) => current.has(id)),
    ...arrived.map((plan) => plan.id),
  ];
  const failed = plans
    .map((plan) => observations.get(plan.id))
    .filter((row) => row !== undefined && row.failure !== null);
  const retryable = failed.filter((row) => row.failure?.action === "retry");
  const failure = (retryable[0] ?? failed[0])?.failure;

  return (
    <>
      {loading && <LoadingPlans count={Math.min(plans.length, 8)} />}
      {!loading && failure && (
        <FailureAlert
          size="compact"
          failure={failure}
          onRetry={() => void Promise.all(retryable.map((row) => row.retry()))}
        />
      )}
      <ul
        className={loading ? undefined : "plan-index-list"}
        hidden={loading}
        role="list"
        aria-label={archived ? "Archived Plans" : "Active Plans"}
      >
        {order.map((id, index) => {
          const plan = current.get(id);
          if (!plan) return null;
          return (
            <ReadPlanIndexRow
              key={id}
              plan={plan}
              step={index + 1}
              onOpen={() => onOpen(id)}
              observe={observe}
            >
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
            </ReadPlanIndexRow>
          );
        })}
      </ul>
    </>
  );
}

function ReadPlanIndexRow({
  plan,
  step,
  onOpen,
  observe,
  children,
}: {
  plan: Plan;
  step: number;
  onOpen: () => void;
  observe: (id: string, row: RowObservation) => void;
  children: ReactNode;
}) {
  const { value, failure, retry, current } = usePlanIndexData(
    plan.id,
    plan.archived,
  );
  // The page needs enough information to sort a new row and show its Retry.
  // The row itself reads the data from the shared cache.
  useLayoutEffect(() => {
    observe(plan.id, {
      answered: current || failure !== null,
      review: (value?.counts?.in_review ?? 0) > 0,
      updated: Date.parse(value?.details?.updated ?? "") || 0,
      failure,
      retry,
    });
  }, [current, failure, observe, plan.id, retry, value]);

  return (
    <li {...enter(step)}>
      {value || failure ? (
        <PlanIndexRow
          plan={plan}
          data={value ?? unknownPlanData}
          onOpen={onOpen}
        >
          {children}
        </PlanIndexRow>
      ) : (
        <PlanIndexRowSkeleton />
      )}
    </li>
  );
}
