import { TicketCommandPicker } from "./TicketCommandPicker";
import {
  archivedProjectHint,
  archivedProjectMatch,
  projectAssignmentChoices,
} from "@/features/projects/project-assignment";
import { TicketAgentStrip } from "./TicketAgent";
import { shortcutLabel, ariaKeyShortcuts } from "@/lib/shortcuts";
import {
  TicketCommandContext,
  ticketCommandActions,
} from "@/lib/ticket-command-actions";
import { LatestUpdate } from "./LatestUpdate";
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChoiceList, type Choice } from "@/components/ui/choice-list";
import { Folder, Layers, type LucideIcon } from "lucide-react";
import { SourceRail } from "./SourceRail";
import {
  duplicateTargetText,
  externalDuplicateTarget,
  externalSource,
  ticketStatusChoices,
} from "./ticket-source";
import { FailureCaption } from "@/components/ui/failure-alert";
import { RecordLink } from "@/components/ui/record-link";
import {
  describeFailure,
  failureText,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { editingBlockedReason, useWorkspaceState } from "@/lib/workspace-state";
import { RailRow, RailSection } from "./RailSection";
import { ticketStatuses } from "@/lib/statuses";
import { StatusIcon } from "./StatusIcon";
import { Duplicates } from "./Duplicates";
import { ConfirmLeaveDuplicate } from "./ConfirmLeaveDuplicate";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { client, type Project, type Ticket } from "@/lib/api/client";
import type { Plan } from "@/lib/api/plans";
import { useSourcesConfigured } from "./use-publication-preview";
import "./properties.css";
import { Badge } from "@/components/ui/badge";
import { m } from "motion/react";
import { CrossfadeText, Presence } from "@/components/ui/motion";
import {
  blur,
  enterTransition,
  exitTransition,
  spring,
} from "@/lib/motion-tokens";

/** The gap between pills, in px: `.rail-tags` in properties.css sets it. */
const PILL_GAP = 4;

/**
 * The tags as pills. A new pill opens its own width and fades up from a soft
 * blur at 94% scale; a removed pill fades out as its width closes. Pills after
 * it make or give up the room as the width moves, in the row's own flow, so a
 * pill never overlaps its neighbour, and the row never reflows at once (a pill
 * that glided to a new line, as layout motion would move it, was clipped by its
 * row and vanished mid-way). A pill's gap opens and closes with it. The pills
 * present when the row appears do not animate.
 *
 * In the strip the whole row is one wrapping item, so a narrowing row would
 * hop to the line above (and leave its "+" behind) part-way through the exit.
 * The row keeps the width it had until the last leaving pill is gone.
 */
function TagPills({ tags }: { tags: string[] }) {
  const root = useRef<HTMLSpanElement>(null);
  const before = useRef(tags);
  const [kept, setKept] = useState<number | null>(null);
  useLayoutEffect(() => {
    const removed = before.current.some((tag) => !tags.includes(tag));
    before.current = tags;
    // The leaving pill is still laid out here, so this is the width it had.
    if (removed && exitTransition().duration > 0 && root.current)
      setKept((width) => width ?? root.current?.offsetWidth ?? null);
  }, [tags]);
  return (
    <span
      ref={root}
      className="rail-tags"
      style={kept === null ? undefined : { minWidth: kept }}
    >
      <Presence initial={false} onExitComplete={() => setKept(null)}>
        {tags.map((tag) => {
          const smooth = spring("smooth");
          return (
            <m.span
              key={tag}
              initial={{
                opacity: 0,
                scale: 0.94,
                filter: `blur(${blur("in")}px)`,
                width: 0,
                marginRight: -PILL_GAP,
                overflow: "clip",
              }}
              animate={{
                opacity: 1,
                scale: 1,
                filter: "blur(0px)",
                width: "auto",
                marginRight: 0,
                transitionEnd: { filter: "none", overflow: "visible" },
                transition: {
                  default: enterTransition(),
                  scale: smooth,
                  width: smooth,
                  marginRight: smooth,
                },
              }}
              exit={{
                opacity: 0,
                filter: `blur(${blur("out")}px)`,
                width: 0,
                marginRight: -PILL_GAP,
                overflow: "clip",
                transition: {
                  default: exitTransition(),
                  width: smooth,
                  marginRight: smooth,
                },
              }}
            >
              <Badge>{tag}</Badge>
            </m.span>
          );
        })}
      </Presence>
      {tags.length === 0 && "No tags"}
    </span>
  );
}

/** The Status choice that opens the duplicate review instead of setting a status. */
const DUPLICATE_ACTION = "mark-duplicate";

/**
 * A rail property's value as a RailRow, and its ChoiceList (P3) in a popover
 * that lines up with the row's end, the rail's edge: rows with the property's
 * icon, the current value checked and highlighted on open, the clearing
 * choice ("No project") last. `multiple` (tags) keeps the list open while
 * values are toggled and offers "Create “x”".
 */
export function PropertyPicker({
  label,
  value,
  empty = false,
  selected,
  choices,
  clear,
  disabled,
  onChoose,
  multiple = false,
  onSearch,
  readOnly = false,
  icon: Icon,
  display,
  things,
  trailing,
  notice,
  emptyHint,
}: {
  label: string;
  /** What the search finds, for its placeholder: "Search projects". */
  things: string;
  /** Shown in the row in place of the value text (the label stays the accessible name). */
  display?: ReactNode;
  readOnly?: boolean;
  icon?: LucideIcon;
  /** The current value's words, for the row. */
  value: string;
  /** The value is the empty one ("No project"): muted. */
  empty?: boolean;
  /** The current choice's value, or the chosen values when `multiple`. */
  selected: string | string[];
  choices: Choice[];
  clear?: Choice;
  disabled: boolean;
  onChoose: (value: string) => void;
  multiple?: boolean;
  onSearch?: (query: string) => void;
  /** The row's trailing slot ("Saving…"). */
  trailing?: ReactNode;
  /** A line above the choices, such as why suggestions are missing. */
  notice?: ReactNode;
  emptyHint?: (query: string) => string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  function choose(next: string) {
    if (!multiple) {
      setOpen(false);
      setQuery("");
      onSearch?.("");
    }
    onChoose(next);
  }
  const icon = Icon && <Icon aria-hidden="true" />;
  const hint = emptyHint?.(query);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <RailRow
          icon={icon}
          muted={empty}
          readOnly={readOnly}
          disabled={disabled}
          aria-label={`${label}: ${value}`}
          title={`${label} (${shortcutLabel(ticketCommandActions.find((action) => action.scope === label)?.shortcut ?? "ticket-tags")})`}
          aria-keyshortcuts={ariaKeyShortcuts(
            ticketCommandActions.find((action) => action.scope === label)
              ?.shortcut ?? "ticket-tags",
          )}
          trailing={trailing}
        >
          {display ?? value}
        </RailRow>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        variant="list"
        aria-label={`${label} choices`}
      >
        <ChoiceList
          label={`${label} choices`}
          searchPlaceholder={`Search ${things}`}
          query={query}
          onQueryChange={(next) => {
            setQuery(next);
            onSearch?.(next);
          }}
          groups={choices
            .filter((choice) =>
              choice.label.toLowerCase().includes(query.trim().toLowerCase()),
            )
            .map((choice) => ({ ...choice, ...(icon && { icon }) }))}
          {...(clear &&
            !query.trim() && { clear: { ...clear, ...(icon && { icon }) } })}
          selected={selected}
          onSelect={choose}
          {...(multiple && { create: choose })}
          {...(notice && { notice })}
          {...(hint && {
            empty: (
              <span>
                No matches<span className="block text-xs">{hint}</span>
              </span>
            ),
          })}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The ticket's properties. `rail` is the property rail beside the document,
 * in DESIGN.md section 7's order: Status, Latest update, Chats, Project,
 * Plan, Tags, Attention, then `children` (Relationships, Files), then Source
 * once a source exists. `strip` folds the same RailRows into one wrapping
 * row of ghost chips under the title of a narrow pane, with Follow and the
 * reminder as icon toggles and the latest update on its own line.
 */
export function TicketProperties({
  ticket,
  projects,
  plans,
  onSaved,
  refresh,
  onOpenTicket,
  onOpenNote,
  children,
  chats,
  attention,
  active = true,
  layout = "rail",
}: {
  /** The ticket's Chats, after Status and Latest update. */
  chats?: ReactNode;
  /** Follow and the reminder: the rail's Attention row, or the strip's end. */
  attention?: ReactNode;
  layout?: "rail" | "strip";
  active?: boolean;
  ticket: Ticket;
  projects: Project[];
  plans: Plan[];
  /** Reports the saved Ticket (the write report); awaited before the property settles. */
  onSaved: (ticket: Ticket) => void | Promise<void>;
  refresh: () => Promise<void>;
  /** Sections that follow Attention in the rail: Relationships and Files. */
  children?: ReactNode;
  onOpenNote?: (id: string) => void;
  /** Opens another ticket, such as the canonical ticket of a duplicate. */
  onOpenTicket?: (reference: string) => void;
}) {
  const strip = layout === "strip";
  const openCommand = useContext(TicketCommandContext);
  const propertiesRef = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState("");
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  // Leaving Duplicate drops its link, so the chosen status waits for a yes.
  const [leaving, setLeaving] = useState<string | null>(null);
  // A failed change per property: one caption under its value, "Not saved ·
  // Retry", with the cause under Details. Nothing else in the rail turns red.
  const [errors, setErrors] = useState<
    Record<string, { failure: FailureDescription; retry: () => void } | null>
  >({});
  // While the workspace cannot be written, the controls rest disabled; the
  // workspace band says why once for the window.
  const blocked = editingBlockedReason(useWorkspaceState()) !== null;
  const sourcesConfigured = useSourcesConfigured();
  const [vocabulary, setVocabulary] = useState<string[]>([]);
  const [vocabularyError, setVocabularyError] = useState("");
  const [tagQuery, setTagQuery] = useState("");
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void client
        .searchTags(tagQuery)
        .then((tags) => {
          if (active) {
            setVocabulary(tags);
            setVocabularyError("");
          }
        })
        .catch((reason: unknown) => {
          if (active)
            setVocabularyError(
              `${failureText(reason, "load tag suggestions")} You can still enter a tag.`,
            );
        });
    }, 150);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [tagQuery]);
  async function save(
    key: string,
    action: () => Promise<Ticket>,
    attemptedMove?: string,
  ) {
    const returnFocus =
      document.activeElement instanceof HTMLElement &&
      (document.activeElement.closest('[role="dialog"]') !== null ||
        // The Status select's open list lives in a portal outside the rail.
        document.activeElement.closest('[role="listbox"]') !== null ||
        document.activeElement.closest('[role="menu"]') !== null ||
        propertiesRef.current?.contains(document.activeElement));
    function restoreFocus() {
      if (!returnFocus) return;
      // Focus is "lost" on the page body or on a list that is closing (still in
      // the DOM, or already detached); anywhere else the user moved it on.
      const lost = () => {
        const active = document.activeElement;
        return (
          !(active instanceof HTMLElement) ||
          active === document.body ||
          !active.isConnected ||
          active.closest('[role="listbox"], [role="menu"]') !== null
        );
      };
      const restore = () => {
        if (!lost()) return;
        const selector = `[aria-label^="${key}:"]`;
        propertiesRef.current?.querySelector<HTMLElement>(selector)?.focus();
      };
      // A closing list can still hold focus on the first frame and drop it to
      // the page on the next, so check on both.
      requestAnimationFrame(() => {
        restore();
        requestAnimationFrame(restore);
      });
    }
    setPending(key);
    setErrors((old) => ({ ...old, [key]: null }));
    let updated: Ticket;
    try {
      updated = await action();
    } catch (reason) {
      const failure = describeFailure(
        reason,
        attemptedMove ?? `change the ${key.toLowerCase()}`,
      );
      setErrors((old) => ({
        ...old,
        [key]: {
          failure,
          retry: () => void save(key, action, attemptedMove),
        },
      }));
      setPending("");
      restoreFocus();
      return;
    }
    try {
      // The report shows the saved Ticket and refreshes what follows from it.
      // It never rejects, so a saved change has no "not refreshed" state.
      await onSaved(updated);
    } finally {
      setPending("");
      restoreFocus();
    }
  }
  const statusTrigger = useRef<HTMLButtonElement>(null);
  const readOnly = ticket.trashed;
  const disabled = readOnly || !!pending || blocked;
  const owner = externalSource(ticket);
  const ownerName = owner ? owner.provider_name : "";
  // While the issue is open its Todo, In progress and In review are local;
  // closing states follow the source and cannot be chosen here.
  const target = externalDuplicateTarget(ticket);
  const resolvedTarget = target?.kind === "external" ? target.ticket : null;
  // The core says which statuses may be chosen; the current one is always shown.
  const statusChoices = ticketStatusChoices(ticket);
  const project = projects.find((p) => p.id === ticket.project_id);
  const projectName = project
    ? `${project.name}${project.archived ? " (archived)" : ""}`
    : ticket.project_id || "No project";
  const plan = plans.find((e) => e.id === ticket.plan_id);
  const planName = plan
    ? `${plan.name}${plan.archived ? " (archived)" : ""}`
    : ticket.plan_id || "No Plan";
  /** "Saving…" in the row's trailing slot: nothing moves while a change is sent. */
  const saving = (label: string) =>
    pending === label ? <span role="status">Saving…</span> : undefined;
  /** The value and, under it, a failed change's one caption. */
  function property(label: string, control: ReactNode) {
    const feedback = (
      <>
        {control}
        {errors[label] && (
          <FailureCaption
            failure={errors[label].failure}
            onRetry={errors[label].retry}
            showSentence={errors[label].failure.code === "project_archived"}
          />
        )}
      </>
    );
    return strip ? (
      feedback
    ) : (
      <RailSection label={label}>{feedback}</RailSection>
    );
  }
  // Shown under Status in the rail; the strip gives it a line after the chips.
  const reportsProgress =
    ticket.status === "In progress" || ticket.status === "In review";
  const latestUpdate = reportsProgress && (
    <LatestUpdate
      active={active}
      onOpen={onOpenNote}
      variant={strip ? "line" : "rail"}
    />
  );
  const duplicate = ticket.status === "Duplicate";
  const statusNotes = !strip && (
    <>
      {/* The canonical link belongs beside the status, trashed or not. */}
      {ticket.duplicate_of && (
        <small className="rail-status-note">
          Duplicate of{" "}
          <RecordLink
            reference={ticket.duplicate_of}
            aria-label={`Duplicate of ${ticket.duplicate_of}`}
            onClick={() => onOpenTicket?.(ticket.duplicate_of!)}
          />
        </small>
      )}
      {target && target.kind !== "unknown" && (
        <small className="rail-status-note">
          {duplicateTargetText(target)}
          {resolvedTarget && (
            <>
              {" · "}
              <RecordLink
                reference={resolvedTarget}
                aria-label={`Open ${resolvedTarget}`}
                onClick={() => onOpenTicket?.(resolvedTarget)}
              >
                Open
              </RecordLink>
            </>
          )}
        </small>
      )}
      {owner && (
        <small className="rail-status-note">
          {owner.closure_unrecognized
            ? `${ownerName} reported an unrecognized state. Choose Done or Canceled here, or check the issue there.`
            : owner.status_locked
              ? `Closed on ${ownerName}. Reopen it there to return this ticket to Todo.`
              : `Your progress, kept in ticketd. ${ownerName} controls when the issue closes.`}
        </small>
      )}
    </>
  );
  const status = property(
    "Status",
    <>
      <div className="rail-status">
        <Select
          value={ticket.status}
          disabled={disabled}
          onValueChange={(status) => {
            if (status === ticket.status) return;
            // Duplicate needs a canonical ticket, so it opens the review.
            if (status === DUPLICATE_ACTION || status === "Duplicate") {
              setDuplicateOpen(true);
              return;
            }
            if (duplicate && ticket.duplicate_of) {
              setLeaving(status);
              return;
            }
            void save("Status", () =>
              client.changeTicket(ticket.reference, { status }),
            );
          }}
        >
          <SelectTrigger
            ref={statusTrigger}
            size="sm"
            variant="ghost"
            readOnly={readOnly}
            aria-label={`Status: ${ticket.status}`}
            title={`Change status (${shortcutLabel("ticket-status")})`}
            aria-keyshortcuts={ariaKeyShortcuts("ticket-status")}
          >
            <StatusIcon status={ticket.status} decorative />
            <SelectValue>
              <CrossfadeText>{ticket.status}</CrossfadeText>
            </SelectValue>
            {saving("Status") && (
              <span className="rail-row-trailing">{saving("Status")}</span>
            )}
          </SelectTrigger>
          <SelectContent
            position="popper"
            align={strip ? "start" : "end"}
            className="status-menu"
            sideOffset={4}
          >
            <SelectGroup>
              {ticketStatuses
                .filter((status) => !owner || statusChoices.includes(status))
                // Duplicate is reached through its review, so it is listed only
                // as the current status, checked like any other.
                .filter(
                  (status) => owner || status !== "Duplicate" || duplicate,
                )
                .map((status) => (
                  <SelectItem key={status} value={status}>
                    <StatusIcon status={status} decorative />
                    {status}
                  </SelectItem>
                ))}
            </SelectGroup>
            {owner &&
              ticketStatuses.some(
                (status) => !statusChoices.includes(status),
              ) && (
                <>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>
                      {owner.closure_unrecognized
                        ? `The state on ${ownerName} is unrecognized`
                        : owner.status_locked
                          ? `Closed on ${ownerName}`
                          : `Set by ${ownerName} when the issue closes`}
                    </SelectLabel>
                    {ticketStatuses
                      .filter((status) => !statusChoices.includes(status))
                      .map((status) => (
                        <SelectItem key={status} value={status} disabled>
                          <StatusIcon status={status} decorative />
                          {status}
                        </SelectItem>
                      ))}
                  </SelectGroup>
                  <p className="status-menu-caption">
                    {owner.closure_unrecognized
                      ? `Choose Done or Canceled here, or check the issue on ${ownerName}.`
                      : owner.status_locked
                        ? `Reopen it on ${ownerName} to work on it again; it comes back as Todo.`
                        : `Done, Canceled and Duplicate follow ${ownerName} when the issue closes.`}
                  </p>
                </>
              )}
            {!owner && (
              <>
                <SelectSeparator />
                <SelectGroup>
                  {/* An action, never the checked status. */}
                  <SelectItem value={DUPLICATE_ACTION}>
                    <StatusIcon status="Duplicate" decorative />
                    {duplicate
                      ? "Change canonical ticket…"
                      : "Mark as duplicate…"}
                  </SelectItem>
                </SelectGroup>
              </>
            )}
          </SelectContent>
        </Select>
      </div>
      {statusNotes}
    </>,
  );
  const projectRow = property(
    "Project",
    <PropertyPicker
      readOnly={readOnly}
      icon={Folder}
      label="Project"
      things="projects"
      value={projectName}
      display={<CrossfadeText>{projectName}</CrossfadeText>}
      empty={!project && !ticket.project_id}
      selected={ticket.project_id ?? ""}
      disabled={disabled}
      trailing={saving("Project")}
      choices={projectAssignmentChoices(projects, ticket.project_id)}
      clear={{ value: "", label: "No project" }}
      emptyHint={(query) => {
        const name = archivedProjectMatch(projects, query);
        return name && archivedProjectHint(name);
      }}
      onChoose={(value) => {
        if (value === (ticket.project_id ?? "")) return;
        const name =
          projects.find((project) => project.id === value)?.name ??
          "No project";
        void save(
          "Project",
          () =>
            client.changeTicket(ticket.reference, {
              project_id: value || null,
            }),
          `move ${ticket.reference} to ${name}`,
        );
      }}
    />,
  );
  const planRow = property(
    "Plan",
    <PropertyPicker
      readOnly={readOnly}
      icon={Layers}
      label="Plan"
      things="Plans"
      value={planName}
      display={<CrossfadeText>{planName}</CrossfadeText>}
      empty={!plan && !ticket.plan_id}
      selected={ticket.plan_id ?? ""}
      disabled={disabled}
      trailing={saving("Plan")}
      choices={plans
        .filter((e) => !e.archived)
        .map((e) => ({ value: e.id, label: e.name }))}
      clear={{ value: "", label: "No Plan" }}
      onChoose={(value) =>
        void save("Plan", () => client.setPlan(ticket.reference, value || null))
      }
    />,
  );
  const pills = <TagPills tags={ticket.tags} />;
  const tagsRow = property(
    "Tags",
    <PropertyPicker
      readOnly={readOnly}
      // The pills are the value: no icon, so they start on the label's edge.
      display={pills}
      label="Tags"
      things="tags"
      value={ticket.tags.length ? ticket.tags.join(", ") : "No tags"}
      empty={ticket.tags.length === 0}
      disabled={disabled}
      trailing={saving("Tags")}
      multiple
      selected={ticket.tags}
      onSearch={setTagQuery}
      {...(vocabularyError && {
        notice: <span className="rail-note">{vocabularyError}</span>,
      })}
      choices={[...new Set([...vocabulary, ...ticket.tags])].map((tag) => ({
        value: tag,
        label: tag,
      }))}
      onChoose={(tag) =>
        void save("Tags", () =>
          client.changeTag(
            ticket.tags.includes(tag) ? "remove_tag" : "add_tag",
            ticket.reference,
            tag,
          ),
        )
      }
    />,
  );
  // "Local" and the Source section appear only once a source is set up, or
  // when this ticket has (or had) one.
  const showSource = Boolean(
    owner || ticket.source || ticket.publication || sourcesConfigured,
  );
  const source = showSource && (
    <SourceRail ticket={ticket} refresh={refresh} chip={strip} />
  );
  const dialogs = (
    <>
      <ConfirmLeaveDuplicate
        canonical={ticket.duplicate_of ?? ""}
        status={leaving}
        returnFocus={statusTrigger}
        onCancel={() => setLeaving(null)}
        onConfirm={(status) => {
          setLeaving(null);
          void save("Status", () =>
            client.changeTicket(ticket.reference, { status }),
          );
        }}
      />
      {duplicateOpen && (
        <Duplicates
          ticket={ticket}
          refresh={refresh}
          open
          onOpenChange={setDuplicateOpen}
          title={`Mark ${ticket.reference} as a duplicate`}
          description={`${ticket.reference} keeps its description and history and becomes Duplicate. Review what points at it.`}
          returnFocus={statusTrigger}
        />
      )}
    </>
  );
  if (strip)
    return (
      <>
        <div
          ref={propertiesRef}
          className="property-strip"
          role="group"
          aria-label="Ticket properties"
          data-trashed={readOnly || undefined}
        >
          {openCommand ? (
            <>
              <TicketCommandPicker
                ticket={ticket}
                projects={projects}
                plans={plans}
                refresh={refresh}
                scope="Status"
                trigger={
                  <RailRow
                    disabled={disabled}
                    icon={<StatusIcon status={ticket.status} decorative />}
                    aria-label={`Status: ${ticket.status}`}

                    aria-keyshortcuts={ariaKeyShortcuts("ticket-status")}
                    title={`Change status (${shortcutLabel("ticket-status")})`}
                  >
                    <CrossfadeText>{ticket.status}</CrossfadeText>
                  </RailRow>
                }
              />
              <TicketCommandPicker
                ticket={ticket}
                projects={projects}
                plans={plans}
                refresh={refresh}
                scope="Project"
                trigger={
                  <RailRow
                    disabled={disabled}
                    muted={!ticket.project_id}
                    icon={<Folder />}
                    aria-label={`Project: ${projectName}`}

                    aria-keyshortcuts={ariaKeyShortcuts("ticket-project")}
                    title={`Change project (${shortcutLabel("ticket-project")})`}
                  >
                    <CrossfadeText>{projectName}</CrossfadeText>
                  </RailRow>
                }
              />
              <TicketCommandPicker
                ticket={ticket}
                projects={projects}
                plans={plans}
                refresh={refresh}
                scope="Plan"
                trigger={
                  <RailRow
                    disabled={disabled}
                    muted={!ticket.plan_id}
                    icon={<Layers />}
                    aria-label={`Plan: ${planName}`}

                    aria-keyshortcuts={ariaKeyShortcuts("ticket-plan")}
                    title={`Move to Plan (${shortcutLabel("ticket-plan")})`}
                  >
                    <CrossfadeText>{planName}</CrossfadeText>
                  </RailRow>
                }
              />
              <TicketCommandPicker
                ticket={ticket}
                projects={projects}
                plans={plans}
                refresh={refresh}
                scope="Tags"
                trigger={
                  <RailRow
                    disabled={disabled}
                    muted={!ticket.tags.length}
                    aria-label={`Tags: ${ticket.tags.join(", ") || "No tags"}`}

                    aria-keyshortcuts={ariaKeyShortcuts("ticket-tags")}
                    title={`Edit tags (${shortcutLabel("ticket-tags")})`}
                  >
                    {pills}
                  </RailRow>
                }
              />
            </>
          ) : (
            <>
              {status}
              {projectRow}
              {planRow}
              {tagsRow}
            </>
          )}
          {chats}
          {source}
          {attention}
          {children}
          {dialogs}
        </div>
        <TicketAgentStrip
          reference={ticket.reference}
          onOpenUpdate={onOpenNote}
        />
      </>
    );
  return (
    <aside
      ref={propertiesRef}
      className="ticket-properties"
      tabIndex={0}
      aria-label="Ticket properties"
      data-trashed={readOnly || undefined}
    >
      {status}
      {latestUpdate}
      {chats}
      {dialogs}
      {projectRow}
      {planRow}
      {tagsRow}
      {attention && (
        <RailSection label="Attention">
          <div className="rail-attention">{attention}</div>
        </RailSection>
      )}
      {children}
      {source}
    </aside>
  );
}
