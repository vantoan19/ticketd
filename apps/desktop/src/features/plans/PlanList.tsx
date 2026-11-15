import { useEffect, useState } from "react";
import { ArchiveRestore, Layers, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Count } from "@/components/ui/count";
import { EmptyState } from "@/components/ui/empty-state";
import { ManagementPage, PageHeader } from "@/components/ui/page-header";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useStatusLine } from "@/components/ui/use-status-line";
import type { Project } from "@/lib/api/client";
import { describeFailure } from "@/lib/api/describe-failure";
import { plansClient, type Plan } from "@/lib/api/plans";
import { emptyCopy } from "@/lib/empty-copy";
import { matchesShortcut, shortcutLabel } from "@/lib/shortcuts";
import { Tooltip } from "@/components/ui/tooltip";
import { NewPlanDialog } from "./NewPlanDialog";
import { PlanCard } from "./PlanCard";
import "./plan.css";
/**
 * The Plans page (DESIGN.md section 10): a management page with "New Plan"
 * in its header, Active and Archived as one segmented choice, and one row per
 * Plan with its progress. An archived row reactivates with Undo.
 */
export function PlanList({
  plans,
  projects = [],
  onTicket,
  archived,
  onOpen,
  onArchivedChange,
  refresh,
}: {
  plans: Plan[];
  projects?: Project[];
  onTicket?: (reference: string) => void;
  archived: boolean;
  onOpen: (id: string) => void;
  /** Switches between the Active and Archived Plans. */
  onArchivedChange?: (archived: boolean) => void;
  refresh: () => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState("");
  const statusLine = useStatusLine();
  const shown = plans.filter((item) => item.archived === archived);
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
        ...(failure.action === "retry" && {
          action: { label: "Retry", run: () => reactivate(item) },
        }),
      });
    } finally {
      setPending("");
    }
  }

  return (
    <ManagementPage layout="centered" aria-labelledby="plan-index-heading">
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
          {shown.map((item) => (
            <li key={item.id}>
              <PlanCard
                plan={item}
                projects={projects}
                onOpen={() => onOpen(item.id)}
                {...(onTicket && { onTicket })}
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
                        disabled={pending === item.id}
                        aria-label={`Reactivate ${item.name}`}
                        onClick={() => void reactivate(item)}
                      >
                        <ArchiveRestore data-icon="inline-start" /> Reactivate
                      </Button>
                    </Tooltip>
                  </span>
                )}
              </PlanCard>
            </li>
          ))}
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
