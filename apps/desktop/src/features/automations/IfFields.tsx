import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { projectName } from "@/features/automations/automation-text";
import type { AutomationCheck } from "@/features/automations/client";
import { checkWords } from "@/features/automations/flow-cards";
import { Pick } from "@/features/automations/TriggerPanel";
import type { Project } from "@/lib/api/client";
import { ticketStatuses } from "@/lib/statuses";

/** The check kinds, as the Add check menu offers them, each as it starts. */
const ADDABLE: { label: string; note: string; blank: AutomationCheck }[] = [
  {
    label: "Tags",
    note: "Has, or does not have, a tag",
    blank: { kind: "tag", tag: "", has: true },
  },
  {
    label: "Status",
    note: "Is, or is not, a status you choose",
    blank: { kind: "status", status: "Todo", is: true },
  },
  {
    label: "Project",
    note: "Is, or is not, a project you choose",
    blank: { kind: "project", project_id: null, is: true },
  },
];
const LABELS = { tag: "Tag", status: "Status", project: "Project" };
const NO_PROJECT = "No project";

/** Chooses between a check and its opposite. */
function Whether({
  label,
  words,
  value,
  onChange,
}: {
  label: string;
  /** What it reads as when true and when false. */
  words: [string, string];
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  const word = (value: boolean) => words[value ? 0 : 1];
  return (
    <Pick name={`${label}: ${word(value)}`} text={word(value)} menu={label}>
      {[true, false].map((choice) => (
        <DropdownMenuItem
          key={String(choice)}
          onSelect={() => onChange(choice)}
        >
          {word(choice)}
        </DropdownMenuItem>
      ))}
    </Pick>
  );
}

/**
 * What an If asks of the ticket, one row a check. The ticket goes down the Yes
 * path when every check passes, and down the No path otherwise.
 */
export function IfFields({
  checks,
  projects,
  onChange,
}: {
  checks: AutomationCheck[];
  projects: Project[];
  onChange: (checks: AutomationCheck[]) => void;
}) {
  const set = (index: number, check: AutomationCheck) =>
    onChange(checks.map((item, at) => (at === index ? check : item)));
  return (
    <div className="flow-panel-section">
      <h4>Check the ticket</h4>
      {checks.map((check, index) => {
        const label = LABELS[check.kind];
        const words = checkWords(check, projects) || "tag";
        const project =
          check.kind === "project" &&
          (check.project_id === null
            ? NO_PROJECT
            : projectName(check.project_id, projects));
        return (
          // Rows have no identity of their own, and none is reordered.
          <div key={index} className="flow-condition">
            <strong>{label}</strong>
            <div className="flow-condition-value">
              {check.kind === "tag" ? (
                <>
                  <Whether
                    label={label}
                    words={["has", "does not have"]}
                    value={check.has}
                    onChange={(has) => set(index, { ...check, has })}
                  />
                  <Input
                    aria-label="Check tag"
                    placeholder="e.g. verified"
                    value={check.tag}
                    // Tags are stored in lower case; show the tag as it will match.
                    onChange={(event) =>
                      set(index, {
                        ...check,
                        tag: event.target.value.toLowerCase(),
                      })
                    }
                  />
                </>
              ) : (
                <>
                  <Whether
                    label={label}
                    words={["is", "is not"]}
                    value={check.is}
                    onChange={(is) => set(index, { ...check, is })}
                  />
                  {check.kind === "status" ? (
                    <Pick
                      name={`Status is: ${check.status}`}
                      text={check.status}
                      menu="Status is"
                    >
                      {ticketStatuses.map((status) => (
                        <DropdownMenuItem
                          key={status}
                          onSelect={() => set(index, { ...check, status })}
                        >
                          {status}
                        </DropdownMenuItem>
                      ))}
                    </Pick>
                  ) : (
                    <Pick
                      name={`Project is: ${project}`}
                      text={project || NO_PROJECT}
                      menu="Project is"
                    >
                      <DropdownMenuItem
                        onSelect={() =>
                          set(index, { ...check, project_id: null })
                        }
                      >
                        {NO_PROJECT}
                      </DropdownMenuItem>
                      {projects.length > 0 && <DropdownMenuSeparator />}
                      {projects.map(({ id, name }) => (
                        <DropdownMenuItem
                          key={id}
                          onSelect={() =>
                            set(index, { ...check, project_id: id })
                          }
                        >
                          {name}
                        </DropdownMenuItem>
                      ))}
                    </Pick>
                  )}
                </>
              )}
            </div>
            <IconButton
              label={`Remove check: ${words[0]?.toUpperCase()}${words.slice(1)}`}
              onClick={() => onChange(checks.filter((_, at) => at !== index))}
            >
              <X aria-hidden />
            </IconButton>
          </div>
        );
      })}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="self-start">
            Add check
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-70"
          aria-label="Add check"
        >
          {ADDABLE.map(({ label, note, blank }) => (
            <DropdownMenuItem
              key={label}
              className="items-start whitespace-normal"
              onSelect={() => onChange([...checks, blank])}
            >
              <span className="flow-menu-item-text">
                {label}
                <small>{note}</small>
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <p className="flow-panel-note">
        Yes when every check passes. Checked against the ticket when this step
        runs.
      </p>
    </div>
  );
}
