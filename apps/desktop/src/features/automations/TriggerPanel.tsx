import { useSources } from "@/features/settings/sources/use-sources";
import { useId, type ReactNode } from "react";
import { ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  LOCAL_SOURCE,
  dayName,
  OR,
  projectName,
  sourceName,
} from "@/features/automations/automation-text";
import {
  WEEKDAYS,
  type AutomationCondition,
  type AutomationSchedule,
  type AutomationTrigger,
} from "@/features/automations/client";
import { useWholeNumber } from "@/features/automations/whole-number";
import type { Project } from "@/lib/api/client";
import { ticketStatuses } from "@/lib/statuses";

/* What the trigger's panel holds: the trigger's own values, then its conditions. */

/** The status a radio item stands for; "" (Any status) is none. */
const statusNamed = (value: string) =>
  ticketStatuses.find((status) => status === value) ?? null;

/** A value chosen from a menu. `name` is the control's name with its value. */
export function Pick({
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

/** Each way to repeat as it is when first chosen. */
const NEW_SCHEDULES: {
  [Kind in AutomationSchedule["kind"]]: Extract<
    AutomationSchedule,
    { kind: Kind }
  >;
} = {
  every_hours: { kind: "every_hours", hours: 6 },
  weekly: { kind: "weekly", time: "09:00", weekdays: ["mon"] },
};

/** The most hours between two runs, a week, as the core allows (`automations.rs`). */
const MOST_HOURS = 168;

/** "Every N hours": saved when it is finished, and a range said while it is not. */
function HoursInput({
  id,
  hours,
  onChange,
}: {
  id: string;
  hours: number;
  onChange: (hours: number) => void;
}) {
  const noteId = useId();
  const field = useWholeNumber({
    value: hours,
    most: MOST_HOURS,
    onCommit: onChange,
  });
  return (
    <>
      <div className="flow-inline">
        <Input
          {...field.inputProps}
          id={id}
          aria-label="Hours"
          aria-invalid={field.invalid || undefined}
          aria-describedby={field.invalid ? noteId : undefined}
        />
        <span>{hours === 1 ? "hour" : "hours"}</span>
      </div>
      {field.invalid && (
        <p id={noteId} role="alert" className="flow-panel-note">
          Every 1 to {MOST_HOURS} hours. For longer, use At set times.
        </p>
      )}
    </>
  );
}

/**
 * When a schedule runs: every few hours, or at a time on chosen weekdays, in
 * this computer's time. There is nothing finer to set.
 */
function ScheduleFields({
  schedule,
  onChange,
}: {
  schedule: AutomationSchedule;
  onChange: (schedule: AutomationSchedule) => void;
}) {
  const id = useId();
  return (
    <>
      <div className="flow-panel-section">
        <span aria-hidden="true">Repeat</span>
        <div>
          <SegmentedControl
            aria-label="Repeat"
            value={schedule.kind}
            onValueChange={(kind) => onChange(NEW_SCHEDULES[kind])}
            options={[
              { value: "every_hours", label: "Every few hours" },
              { value: "weekly", label: "At set times" },
            ]}
          />
        </div>
      </div>
      {schedule.kind === "every_hours" ? (
        <div className="flow-panel-section">
          <label htmlFor={id}>Every</label>
          <HoursInput
            id={id}
            hours={schedule.hours}
            onChange={(hours) => onChange({ ...schedule, hours })}
          />
        </div>
      ) : (
        <div className="flow-panel-section">
          <label htmlFor={id}>At</label>
          <div className="flow-inline">
            <Input
              id={id}
              type="time"
              aria-label="Time"
              value={schedule.time}
              onChange={(event) =>
                onChange({ ...schedule, time: event.target.value })
              }
            />
            <span>on</span>
          </div>
          <div className="flow-days" role="group" aria-label="Days">
            {WEEKDAYS.map((day) => {
              const chosen = schedule.weekdays.includes(day);
              return (
                <Button
                  key={day}
                  variant={chosen ? "default" : "outline"}
                  size="icon-sm"
                  aria-pressed={chosen}
                  aria-label={dayName(day)}
                  onClick={() =>
                    onChange({
                      ...schedule,
                      // Kept in the order of the week.
                      weekdays: WEEKDAYS.filter((item) =>
                        item === day
                          ? !chosen
                          : schedule.weekdays.includes(item),
                      ),
                    })
                  }
                >
                  {dayName(day).charAt(0)}
                </Button>
              );
            })}
          </div>
        </div>
      )}
      <p className="flow-panel-note">
        If ticketd is closed then, it runs once when ticketd next starts.
      </p>
    </>
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
              name={`To: ${trigger.to ?? "choose a status"}`}
              text={trigger.to ?? "Choose a status"}
              menu="To"
            >
              {/* Radio items, so the menu says which one is chosen. */}
              <DropdownMenuRadioGroup
                value={trigger.to ?? ""}
                onValueChange={(to) =>
                  onChange({ ...trigger, to: statusNamed(to) })
                }
              >
                {ticketStatuses.map((status) => (
                  <DropdownMenuRadioItem key={status} value={status}>
                    {status}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </Pick>
          </div>
          <div className="flow-panel-section">
            <span aria-hidden="true">From</span>
            <Pick
              name={`From: ${trigger.from ?? "Any status"}`}
              text={trigger.from ?? "Any status"}
              menu="From"
            >
              {/* "" is Any status: a radio value cannot be null. */}
              <DropdownMenuRadioGroup
                value={trigger.from ?? ""}
                onValueChange={(from) =>
                  onChange({ ...trigger, from: statusNamed(from) })
                }
              >
                <DropdownMenuRadioItem value="">
                  Any status
                </DropdownMenuRadioItem>
                <DropdownMenuSeparator />
                {ticketStatuses.map((status) => (
                  <DropdownMenuRadioItem key={status} value={status}>
                    {status}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
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
    case "schedule":
      return (
        <ScheduleFields
          schedule={trigger.schedule}
          onChange={(schedule) => onChange({ ...trigger, schedule })}
        />
      );
    case "by_hand":
      return (
        <p className="flow-panel-note">
          Starts only when you press Run now. It runs without a ticket, so its
          agent works from its instructions alone.
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
    note: "Is one of the sources you choose",
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
  const { entries: sources } = useSources();
  const providers = [
    ...new Set(sources.map(({ connector }) => connector.provider)),
  ];
  const sourceNote = OR.format([
    ...providers.map((provider) => sourceName(provider, sources)),
    "Local",
  ]);
  const set = (index: number, condition: AutomationCondition) =>
    onChange(conditions.map((item, at) => (at === index ? condition : item)));
  return (
    <div className="flow-panel-section">
      <h4>Only when</h4>
      {conditions.map((condition, index) => {
        const sourceOptions =
          condition.kind === "source"
            ? [...new Set([...providers, LOCAL_SOURCE, ...condition.any_of])]
            : [];
        const has =
          condition.kind === "tag" && (condition.has ? "has" : "does not have");
        // The projects or the source it names; nothing until one is chosen.
        const value =
          condition.kind !== "tag" && condition.any_of.length > 0
            ? OR.format(
                condition.any_of.map((item) =>
                  condition.kind === "project"
                    ? projectName(item, projects)
                    : sourceName(item, sources),
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
                  {!projects.some(
                    (project) =>
                      !project.archived ||
                      condition.any_of.includes(project.id),
                  ) && (
                    <DropdownMenuItem disabled>
                      No projects to choose
                    </DropdownMenuItem>
                  )}
                  {projects
                    .filter(
                      (project) =>
                        !project.archived ||
                        condition.any_of.includes(project.id),
                    )
                    .map((project) => (
                      <DropdownMenuCheckboxItem
                        key={project.id}
                        // Open for the next pick: one condition names several.
                        onSelect={(event) => event.preventDefault()}
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
                        {projectName(project.id, projects)}
                      </DropdownMenuCheckboxItem>
                    ))}
                </Pick>
              ) : (
                <Pick
                  name={value ? `Source is: ${value}` : "Source is"}
                  text={value ? `is ${value}` : "Choose sources"}
                  menu="Source is"
                >
                  {/* One of several, like the projects. */}
                  {sourceOptions.map((source) => (
                    <DropdownMenuCheckboxItem
                      key={source}
                      // Open for the next pick: one condition names several.
                      onSelect={(event) => event.preventDefault()}
                      checked={condition.any_of.includes(source)}
                      onCheckedChange={(checked) =>
                        set(index, {
                          ...condition,
                          // Kept in the order the menu lists them.
                          any_of: sourceOptions.filter((item) =>
                            item === source
                              ? checked
                              : condition.any_of.includes(item),
                          ),
                        })
                      }
                    >
                      {sourceName(source, sources)}
                    </DropdownMenuCheckboxItem>
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
                // Not `disabled`, which the arrow keys skip: it stays in reach
                // and says why it is unavailable.
                {...(taken
                  ? {
                      "aria-disabled": true,
                      // Drawn as a disabled item is.
                      "data-disabled": "",
                      onSelect: (event: Event) => event.preventDefault(),
                    }
                  : { onSelect: () => onChange([...conditions, blank]) })}
              >
                <span className="flow-menu-item-text">
                  {label}
                  <small>
                    {taken
                      ? "Already a condition"
                      : blank.kind === "source"
                        ? sourceNote
                        : note}
                  </small>
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
