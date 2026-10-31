import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BulkAction } from "@/features/tickets/BulkAction";
import type { BulkEdit } from "@/features/tickets/useBulkEdit";
import type { TicketWorkspace } from "@/features/tickets/useTicketWorkspace";

export function BulkControls({
  bulk,
  projects,
  efforts,
}: {
  bulk: BulkEdit;
  projects: TicketWorkspace["projects"];
  efforts: TicketWorkspace["efforts"];
}) {
  const { pending, action, error } = bulk;
  return (
    <div className="bulk-controls" role="region" aria-label="Bulk edit">
      <span aria-live="polite" title={bulk.selection.join(", ")}>
        {bulk.selection.length} selected
      </span>
      {bulk.selection.length > 0 && (
        <div className="bulk-actions">
          <BulkAction
            label="Status"
            disabled={pending}
            open={action === "Status"}
            onOpenChange={(open) => bulk.setAction(open ? "Status" : null)}
            error={error}
          >
            <label>
              Status for selected tickets
              <select
                aria-label="Status for selected tickets"
                value={bulk.status}
                onChange={(event) => bulk.setStatus(event.target.value)}
                disabled={pending}
              >
                <option value="">Choose status</option>
                {["Todo", "In progress", "In review", "Done", "Canceled"].map(
                  (value) => (
                    <option key={value}>{value}</option>
                  ),
                )}
              </select>
            </label>
            <Button
              disabled={!bulk.status || pending}
              onClick={() => void bulk.applyStatus()}
            >
              {pending ? "Applying…" : "Apply status"}
            </Button>
          </BulkAction>
          <BulkAction
            label="Project"
            disabled={pending}
            open={action === "Project"}
            onOpenChange={(open) => bulk.setAction(open ? "Project" : null)}
            error={error}
          >
            <label>
              Project for selected tickets
              <select
                aria-label="Project for selected tickets"
                value={bulk.project}
                onChange={(event) => bulk.setProject(event.target.value)}
                disabled={pending}
              >
                <option value="">Choose project</option>
                <option value="__clear__">Clear project</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            <Button
              disabled={!bulk.project || pending}
              onClick={() =>
                void bulk.applyOrganization({
                  project_id:
                    bulk.project === "__clear__" ? null : bulk.project,
                })
              }
            >
              {pending ? "Applying…" : "Apply project"}
            </Button>
          </BulkAction>
          <BulkAction
            label="Effort"
            disabled={pending}
            open={action === "Effort"}
            onOpenChange={(open) => bulk.setAction(open ? "Effort" : null)}
            error={error}
          >
            <label>
              Effort for selected tickets
              <select
                aria-label="Effort for selected tickets"
                value={bulk.effort}
                onChange={(event) => bulk.setEffort(event.target.value)}
                disabled={pending}
              >
                <option value="">Choose Effort</option>
                <option value="__clear__">Clear Effort</option>
                {efforts
                  .filter((item) => !item.archived)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </select>
            </label>
            <Button
              disabled={!bulk.effort || pending}
              onClick={() =>
                void bulk.applyOrganization({
                  effort_id: bulk.effort === "__clear__" ? null : bulk.effort,
                })
              }
            >
              {pending ? "Applying…" : "Apply Effort"}
            </Button>
          </BulkAction>
          <BulkAction
            label="Tags"
            disabled={pending}
            open={action === "Tags"}
            onOpenChange={(open) => bulk.setAction(open ? "Tags" : null)}
            error={error}
          >
            <label>
              Tag for selected tickets
              <input
                aria-label="Tag for selected tickets"
                placeholder="Tag name"
                value={bulk.tag}
                onChange={(event) => bulk.setTag(event.target.value)}
                disabled={pending}
              />
            </label>
            <Button
              disabled={!bulk.tag.trim() || pending}
              onClick={() =>
                void bulk.applyOrganization({ add_tags: [bulk.tag.trim()] })
              }
            >
              Add tag
            </Button>
            <Button
              variant="outline"
              disabled={!bulk.tag.trim() || pending}
              onClick={() =>
                void bulk.applyOrganization({ remove_tags: [bulk.tag.trim()] })
              }
            >
              Remove tag
            </Button>
          </BulkAction>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Clear selection"
            disabled={pending}
            onClick={bulk.clearSelection}
          >
            <X />
          </Button>
        </div>
      )}
      {error && !action && <p role="alert">{error}</p>}
    </div>
  );
}
