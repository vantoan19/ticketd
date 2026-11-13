import { useId, type ReactNode } from "react";
import { ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import {
  CONDITION_SOURCES,
  OR,
  projectName,
  sourceName,
} from "@/features/automations/automation-text";
import type {
  AutomationCondition,
  AutomationTrigger,
} from "@/features/automations/client";
import type { Project } from "@/lib/api/client";
import { ticketStatuses } from "@/lib/statuses";

/* What the trigger's panel holds: the trigger's own values, then its conditions. */

/** A value chosen from a menu. `name` is the control's name with its value. */
function Pick({
  name,
  text,
  menu,
  children,
}: {
  name: string;
  text: string;
  /** What the menu is called. */
  menu: string;
  children: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="w-full justify-start"
          aria-label={name}
        >
          <span className="flow-pick-text">{text}</span>
          <ChevronDown aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" aria-label={menu}>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TagField({
  tag,
  note,
  onChange,
}: {
  tag: string;
  note: string;
  onChange: (tag: string) => void;
}) {
  const id = useId();
  return (
    <div className="flow-panel-section">
      <label htmlFor={id}>Tag</label>
      <Input
        id={id}
        placeholder="e.g. ready-for-triage"
        value={tag}
        // Tags are stored in lower case; show the tag as it will match.
        onChange={(event) => onChange(event.target.value.toLowerCase())}
      />
      <p className="flow-panel-note">{note}</p>
    </div>
  );
}

/** The values a trigger of this kind takes; some take none. */
export function TriggerFields({
  trigger,
  onChange,
}: {
  trigger: AutomationTrigger;
  onChange: (trigger: AutomationTrigger) => void;
}) {
  switch (trigger.kind) {
    case "tag_added":
      return (
        <TagField
          tag={trigger.tag}
          note="Starts when this tag is added to a ticket, or a ticket is created with it."
          onChange={(tag) => onChange({ ...trigger, tag })}
        />
      );
    case "tag_removed":
      return (
        <TagField
          tag={trigger.tag}
          note="Starts when this tag is removed from a ticket."
          onChange={(tag) => onChange({ ...trigger, tag })}
        />
      );
    case "status_changed":
      return (
        <>
          <div className="flow-panel-section">
            <span aria-hidden="true">To</span>
            <Pick
              name={trigger.to ? `To: ${trigger.to}` : "To"}
              text={trigger.to ?? "Choose a status"}
              menu="To"
            >
              {ticketStatuses.map((status) => (
                <DropdownMenuItem
                  key={status}
                  onSelect={() => onChange({ ...trigger, to: status })}
                >
                  {status}
                </DropdownMenuItem>
              ))}
            </Pick>
          </div>
          <div className="flow-panel-section">
            <span aria-hidden="true">From</span>
            <Pick
              name={`From: ${trigger.from ?? "Any status"}`}
              text={trigger.from ?? "Any status"}
              menu="From"
            >
              <DropdownMenuItem
                onSelect={() => onChange({ ...trigger, from: null })}
              >
                Any status
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {ticketStatuses.map((status) => (
                <DropdownMenuItem
                  key={status}
                  onSelect={() => onChange({ ...trigger, from: status })}
                >
                  {status}
                </DropdownMenuItem>
              ))}
            </Pick>
          </div>
        </>
      );
    case "ticket_updated":
      return (
        <p className="flow-panel-note">
          Starts when a ticket&apos;s title, description, project or Plan
          changes.
        </p>
      );
    case "activity_created":
      return (
        <p className="flow-panel-note">
          Starts when an update is posted on a ticket.
        </p>
      );
    default:
      return null;
  }
}

/** The condition kinds, as the Add condition menu offers them. */
const ADDABLE: {
  label: string;
  note: string;
  blank: AutomationCondition;
}[] = [
  {
    label: "Project",
    note: "Is one of the projects you choose",
    blank: { kind: "project", any_of: [] },
  },
  {
    label: "Source",
    note: "GitHub or Local",
    blank: { kind: "source", any_of: [] },
  },
  {
    label: "Tags",
    note: "Has, or does not have, a tag",
    blank: { kind: "tag", tag: "", has: true },
  },
];

/**
 * The conditions that narrow a trigger, one row each. A ticket has one project
 * and one source, so each of those is one row naming several; tags take a row
 * per tag.
 */
export function ConditionRows({
  conditions,
  projects,
  onChange,
}: {
  conditions: AutomationCondition[];
  projects: Project[];
  onChange: (conditions: AutomationCondition[]) => void;
}) {
  const set = (index: number, condition: AutomationCondition) =>
    onChange(conditions.map((item, at) => (at === index ? condition : item)));
  return (
    <div className="flow-panel-section">
      <h4>Only when</h4>
      {conditions.map((condition, index) => {
        const has =
          condition.kind === "tag" && (condition.has ? "has" : "does not have");
        // The projects or the source it names; nothing until one is chosen.
        const value =
          condition.kind !== "tag" && condition.any_of.length > 0
            ? OR.format(
                condition.any_of.map((item) =>
                  condition.kind === "project"
                    ? projectName(item, projects)
                    : sourceName(item),
                ),
              )
            : null;
        const label =
          condition.kind === "tag"
            ? "Tag"
            : condition.kind === "project"
              ? "Project"
              : "Source";
        const words =
          condition.kind === "tag"
            ? `Tag ${has} ${condition.tag}`.trim()
            : value
              ? `${label} is ${value}`
              : label;
        return (
          // Rows have no identity of their own, and none is reordered.
          <div key={index} className="flow-condition">
            <strong>{label}</strong>
            <div className="flow-condition-value">
              {condition.kind === "tag" ? (
                <>
                  <Pick name={`Tag: ${has}`} text={has || ""} menu="Tag">
                    {[true, false].map((has) => (
                      <DropdownMenuItem
                        key={String(has)}
                        onSelect={() => set(index, { ...condition, has })}
                      >
                        {has ? "has" : "does not have"}
                      </DropdownMenuItem>
                    ))}
                  </Pick>
                  <Input
                    aria-label="Condition tag"
                    placeholder="e.g. bug"
                    value={condition.tag}
                    onChange={(event) =>
                      set(index, {
                        ...condition,
                        tag: event.target.value.toLowerCase(),
                      })
                    }
                  />
                </>
              ) : condition.kind === "project" ? (
                <Pick
                  name={value ? `Project is: ${value}` : "Project is"}
                  text={value ? `is ${value}` : "Choose projects"}
                  menu="Project is"
                >
                  {projects.length === 0 && (
                    <DropdownMenuItem disabled>
                      No projects yet
                    </DropdownMenuItem>
                  )}
                  {projects.map((project) => (
                    <DropdownMenuCheckboxItem
                      key={project.id}
                      checked={condition.any_of.includes(project.id)}
                      onCheckedChange={(checked) =>
                        set(index, {
                          ...condition,
                          any_of: checked
                            ? [...condition.any_of, project.id]
                            : condition.any_of.filter(
                                (id) => id !== project.id,
                              ),
                        })
                      }
                    >
                      {project.name}
                    </DropdownMenuCheckboxItem>
                  ))}
                </Pick>
              ) : (
                <Pick
                  name={value ? `Source is: ${value}` : "Source is"}
                  text={value ? `is ${value}` : "Choose a source"}
                  menu="Source is"
                >
                  {CONDITION_SOURCES.map((source) => (
                    <DropdownMenuItem
                      key={source}
                      onSelect={() =>
                        set(index, { ...condition, any_of: [source] })
                      }
                    >
                      {sourceName(source)}
                    </DropdownMenuItem>
                  ))}
                </Pick>
              )}
            </div>
            <IconButton
              label={`Remove condition: ${words}`}
              onClick={() =>
                onChange(conditions.filter((_, at) => at !== index))
              }
            >
              <X aria-hidden />
            </IconButton>
          </div>
        );
      })}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="self-start">
            Add condition
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-70"
          aria-label="Add condition"
        >
          {ADDABLE.map(({ label, note, blank }) => {
            const taken =
              blank.kind !== "tag" &&
              conditions.some((item) => item.kind === blank.kind);
            return (
              <DropdownMenuItem
                key={label}
                className="items-start whitespace-normal"
                disabled={taken}
                onSelect={() => onChange([...conditions, blank])}
              >
                <span className="flow-menu-item-text">
                  {label}
                  <small>{taken ? "Already a condition" : note}</small>
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      {conditions.length > 0 && (
        <p className="flow-panel-note">All conditions must match.</p>
      )}
    </div>
  );
}
