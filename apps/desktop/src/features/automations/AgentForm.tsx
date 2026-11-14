import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Ellipsis, Maximize2, Minimize2, X } from "lucide-react";
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ChoiceTile, ChoiceTiles } from "@/components/ui/choice-tiles";
import { DialogShell } from "@/components/ui/dialog-shell";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { StatusDot } from "@/components/ui/status-dot";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  automationAgentSettingsSchema,
  type AutomationAgent,
  type AutomationAgentSettings,
} from "@/features/automations/client";
import { FIXED_ON_FOR_CODEX } from "@/features/automations/automation-text";
import { useChatClient, type HarnessStatus } from "@/features/chats/client";
import {
  SettingsList,
  SettingsListFooter,
} from "@/features/settings/layout/SettingsList";
import "@/features/settings/layout/settings-layout.css";

type Harness = AutomationAgentSettings["harness"];
type Tools = AutomationAgentSettings["tools"];

const HARNESSES: { id: Harness; name: string }[] = [
  { id: "claude-code", name: "Claude Code" },
  { id: "codex", name: "Codex" },
];

/** What a harness tile says about this computer, and whether it can be chosen. */
function harnessStanding(status: HarnessStatus["status"] | undefined): {
  label: string;
  tone: "positive" | "attention" | "neutral";
  usable: boolean;
} {
  switch (status) {
    case undefined:
      return { label: "Checking…", tone: "neutral", usable: true };
    case "ready":
    case "not_subscription":
    case "sign_in_unknown":
      return { label: "Ready", tone: "positive", usable: true };
    case "not_signed_in":
      return { label: "Not signed in", tone: "attention", usable: true };
    case "unknown":
      return { label: "Could not check", tone: "neutral", usable: true };
    case "not_installed":
      return { label: "Not installed", tone: "neutral", usable: false };
    case "incompatible":
      return { label: "Needs an update", tone: "neutral", usable: false };
    case "unavailable":
      return { label: "Not available", tone: "neutral", usable: false };
  }
}

/**
 * One line of the agent editor: what it is, a note that gives way first, and
 * its control. `children` go underneath, across the row.
 */
function ToolRow({
  title,
  description,
  control,
  children,
}: {
  title: string;
  description: string;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="agent-tool">
      <span className="agent-tool-title">{title}</span>
      <span className="agent-tool-desc">{description}</span>
      <span className="agent-tool-control">{control}</span>
      {children && <div className="agent-tool-more">{children}</div>}
    </div>
  );
}

const TOOLS: {
  key: Exclude<keyof Tools, "allowed_commands" | "any_command">;
  title: string;
  description: string;
}[] = [
  {
    key: "read_files",
    title: "Read files",
    description: "In the step’s folder",
  },
  {
    key: "edit_files",
    title: "Edit files",
    description: "In the step’s folder",
  },
  {
    key: "run_commands",
    title: "Run commands",
    description: "Any command, or only the ones you list",
  },
  {
    key: "use_web",
    title: "Use the web",
    description: "Search and fetch pages",
  },
];

/** The largest limits the core accepts (`automation_agents.rs`), offered as each field's range. */
const MOST_TURNS = 500;
const MOST_MINUTES = 240;

/**
 * A limit row: a whole number from 1 to `most`, saved only while it is one and
 * said under the field while it is not.
 */
function LimitRow({
  title,
  description,
  most,
  value,
  disabled,
  onSave,
}: {
  title: string;
  description: string;
  most: number;
  value: number;
  disabled?: boolean;
  onSave: (value: number) => void;
}) {
  const noteId = useId();
  const [text, setText] = useState(String(value));
  const inRange = (next: number) =>
    Number.isInteger(next) && next >= 1 && next <= most;
  const invalid = !disabled && !inRange(Number(text));
  return (
    <ToolRow
      title={title}
      description={description}
      control={
        <Input
          type="number"
          min={1}
          max={most}
          step={1}
          className="h-8 w-18"
          aria-label={title}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? noteId : undefined}
          disabled={disabled}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            const next = Number(event.target.value);
            if (inRange(next)) onSave(next);
          }}
          // Leaving the field with something that is not a limit shows the saved one.
          onBlur={() => setText(String(value))}
        />
      }
    >
      {invalid && (
        <p id={noteId} role="alert" className="agent-hint agent-hint-error">
          A whole number from 1 to {most}. Until then, {value} is kept.
        </p>
      )}
    </ToolRow>
  );
}

/** What is edited and sent back on a save: the agent without its id. */
const settingsOf = (agent: AutomationAgent): AutomationAgentSettings =>
  automationAgentSettingsSchema.parse(agent);

/**
 * One Automation agent, edited in place: every change is saved as it is made.
 * Mount it with the agent's id as `key`. It keeps the settings being edited and
 * takes an agent changed elsewhere (Workspace sync, another window) unless that
 * would lose a change of its own that was not saved; then it asks.
 */
export function AgentForm({
  agent,
  expanded,
  single,
  onExpand,
  onReturn,
  onClose,
  onSave,
  onDelete,
}: {
  agent: AutomationAgent;
  expanded: boolean;
  single: boolean;
  /** Omitted where the form has no list to expand from. */
  onExpand?: () => void;
  onReturn: () => void;
  onClose: () => void;
  /** Saves the settings and resolves to the agent as it is then stored. */
  onSave: (settings: AutomationAgentSettings) => Promise<AutomationAgent>;
  onDelete: () => void;
}) {
  const client = useChatClient();
  const fieldId = useId();
  const [draft, setDraft] = useState(() => settingsOf(agent));
  /** The command list as typed: one per line, blank lines and all. */
  const [commands, setCommands] = useState(
    agent.tools.allowed_commands.join("\n"),
  );
  /** The settings as the core last said they are stored, to tell a change made elsewhere. */
  const arrived = JSON.stringify(settingsOf(agent));
  const [stored, setStored] = useState(arrived);
  const [seen, setSeen] = useState(arrived);
  /** Saves sent and not yet answered. */
  const [saving, setSaving] = useState(0);
  const sends = useRef(0);
  /** The last save failed: the draft holds a change that is not stored. */
  const [unsaved, setUnsaved] = useState(false);
  /** Settings changed elsewhere while a change here was not saved. */
  const [elsewhere, setElsewhere] = useState<AutomationAgentSettings | null>(
    null,
  );
  /** Counts the settings taken from elsewhere, to restart fields that keep their own text. */
  const [taken, setTaken] = useState(0);
  const take = (settings: AutomationAgentSettings) => {
    setStored(JSON.stringify(settings));
    setDraft(settings);
    setCommands(settings.tools.allowed_commands.join("\n"));
    setTaken((count) => count + 1);
    setUnsaved(false);
    setElsewhere(null);
  };
  if (arrived !== seen) {
    setSeen(arrived);
    // While a save is on its way, its answer says what is stored.
    if (saving === 0 && arrived !== stored) {
      if (unsaved) setElsewhere(settingsOf(agent));
      else take(settingsOf(agent));
    }
  }
  /** null until the probe answers: seconds, while each harness is asked. */
  const [found, setFound] = useState<HarnessStatus[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    let current = true;
    client.harnesses().then(
      (harnesses) => current && setFound(harnesses),
      () => current && setFound([]),
    );
    return () => {
      current = false;
    };
  }, [client]);

  const save = (next: AutomationAgentSettings) => {
    const sent = ++sends.current;
    setSaving((count) => count + 1);
    onSave(next).then(
      (saved) => {
        setSaving((count) => count - 1);
        setStored(JSON.stringify(settingsOf(saved)));
        // Only the latest save says how things stand.
        if (sent === sends.current) setUnsaved(false);
      },
      () => {
        setSaving((count) => count - 1);
        if (sent === sends.current) setUnsaved(true);
      },
    );
  };
  const change = (patch: Partial<AutomationAgentSettings>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    save(next);
  };
  const changeTools = (patch: Partial<Tools>) =>
    change({ tools: { ...draft.tools, ...patch } });
  const codex = draft.harness === "codex";
  const title = draft.name.trim() || "New agent";
  /** An Automation with a step that runs this agent: it cannot be deleted. */
  const usedBy = agent.used_by[0];
  const harnessName =
    HARNESSES.find((item) => item.id === draft.harness)?.name ?? "Harness";
  const standings = HARNESSES.map((harness) => ({
    ...harness,
    standing: harnessStanding(
      found
        ? (found.find((item) => item.id === harness.id)?.status ??
            "not_installed")
        : undefined,
    ),
  }));
  const missing = standings.filter((harness) => !harness.standing.usable);

  return (
    <section
      className="ticket-detail chat-pane"
      aria-labelledby={`${fieldId}-heading`}
    >
      <div className="detail-header">
        <div className="detail-title-group">
          {single && (
            <IconButton label="Back to Agents" onClick={onReturn}>
              <ArrowLeft aria-hidden />
            </IconButton>
          )}
          <h2
            id={`${fieldId}-heading`}
            className="chat-head-title"
            tabIndex={-1}
          >
            {title}
          </h2>
        </div>
        <div className="detail-actions">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label="Agent actions">
                <Ellipsis aria-hidden />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" aria-label="Agent actions">
              <DropdownMenuItem
                variant="destructive"
                className="items-start whitespace-normal"
                disabled={usedBy !== undefined}
                onSelect={() => setDeleting(true)}
              >
                <span className="flow-menu-item-text">
                  Delete…
                  {usedBy !== undefined && (
                    <small>
                      Used by {usedBy.trim() || "New Automation"}. Change that
                      step first.
                    </small>
                  )}
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {expanded ? (
            <IconButton label="Show beside the list" onClick={onReturn}>
              <Minimize2 aria-hidden />
            </IconButton>
          ) : (
            !single &&
            onExpand && (
              <IconButton label="Expand agent" onClick={onExpand}>
                <Maximize2 aria-hidden />
              </IconButton>
            )
          )}
          <IconButton label="Close agent" onClick={onClose}>
            <X aria-hidden />
          </IconButton>
        </div>
      </div>
      <div className="agent-form">
        <div className="agent-column">
          {elsewhere && (
            <Alert size="compact">
              <AlertTitle>Changed somewhere else</AlertTitle>
              <AlertDescription>
                This agent was changed elsewhere while your last change was not
                saved.
              </AlertDescription>
              <AlertActions>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => take(elsewhere)}
                >
                  Use that version
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setElsewhere(null);
                    save(draft);
                  }}
                >
                  Keep mine
                </Button>
              </AlertActions>
            </Alert>
          )}
          <div className="agent-field">
            <label className="agent-label" htmlFor={`${fieldId}-name`}>
              Name
            </label>
            <Input
              id={`${fieldId}-name`}
              placeholder="e.g. Triage"
              value={draft.name}
              onChange={(event) => change({ name: event.target.value })}
            />
          </div>
          <div className="agent-field">
            <span className="agent-label" id={`${fieldId}-harness`}>
              Harness
            </span>
            <ChoiceTiles
              aria-labelledby={`${fieldId}-harness`}
              value={draft.harness}
              // A model names one harness's model, so it does not carry over.
              onValueChange={(harness) =>
                harness !== draft.harness &&
                change({ harness: harness as Harness, model: null })
              }
            >
              {standings.map(({ id, name, standing }) => (
                <ChoiceTile
                  key={id}
                  value={id}
                  title={name}
                  // The agent's own harness stays shown as chosen where it is missing.
                  disabled={!standing.usable && id !== draft.harness}
                  description={
                    <span className="agent-standing">
                      <StatusDot tone={standing.tone} />
                      {standing.label}
                    </span>
                  }
                />
              ))}
            </ChoiceTiles>
            {missing.map(({ id, name }) => (
              <p key={id} className="agent-hint">
                {name} cannot run on this computer. Install or update it, then
                open this again.
              </p>
            ))}
          </div>
          <div className="agent-field">
            <label className="agent-label" htmlFor={`${fieldId}-model`}>
              Model
              <small>Leave empty for the harness default</small>
            </label>
            <Input
              id={`${fieldId}-model`}
              placeholder={`${harnessName} default`}
              value={draft.model ?? ""}
              onChange={(event) =>
                change({ model: event.target.value || null })
              }
            />
          </div>
          <div className="agent-field">
            <label className="agent-label" htmlFor={`${fieldId}-instructions`}>
              Instructions
              <small>The first message of every run, before the ticket</small>
            </label>
            <Textarea
              id={`${fieldId}-instructions`}
              className="min-h-42"
              placeholder="What should this agent do with a ticket? It reads the ticket with the ticketd command line and records its result there."
              value={draft.instructions}
              onChange={(event) => change({ instructions: event.target.value })}
            />
          </div>
          <div className="agent-field">
            <span className="agent-label">Allowed tools</span>
            <SettingsList>
              {TOOLS.map(({ key, title: tool, description }) => {
                const fixed = codex && FIXED_ON_FOR_CODEX.has(key);
                return (
                  <ToolRow
                    key={key}
                    title={tool}
                    description={fixed ? "Always on with Codex" : description}
                    control={
                      <Switch
                        aria-label={tool}
                        disabled={fixed}
                        checked={fixed || draft.tools[key]}
                        onCheckedChange={(on) => changeTools({ [key]: on })}
                      />
                    }
                  >
                    {key === "run_commands" &&
                      !codex &&
                      draft.tools.run_commands && (
                        <>
                          {/* Chosen outright: an empty list never means "any". */}
                          <SegmentedControl
                            aria-label="Which commands"
                            value={draft.tools.any_command ? "any" : "listed"}
                            onValueChange={(which) =>
                              changeTools({ any_command: which === "any" })
                            }
                            options={[
                              { value: "listed", label: "Only these" },
                              { value: "any", label: "Any command" },
                            ]}
                          />
                          {!draft.tools.any_command && (
                            <Textarea
                              aria-label="Allowed commands"
                              placeholder="One command per line. With none listed, no command runs."
                              value={commands}
                              onChange={(event) => {
                                setCommands(event.target.value);
                                changeTools({
                                  allowed_commands: event.target.value
                                    .split("\n")
                                    .map((line) => line.trim())
                                    .filter(Boolean),
                                });
                              }}
                            />
                          )}
                        </>
                      )}
                  </ToolRow>
                );
              })}
              <ToolRow
                title="ticketd command line"
                description="Always allowed"
              />
              <SettingsListFooter>
                Anything else is denied. A step that needs approval fails; it
                never asks.
              </SettingsListFooter>
            </SettingsList>
            {codex ? (
              <p className="agent-hint">
                Codex applies its own sandbox: it reads files, runs any command,
                and writes only in the step’s folder and your ticketd data. Your
                own choices are kept for Claude Code.
              </p>
            ) : (
              <p className="agent-hint">
                Claude Code may still run shell commands that only read, such as
                listing a folder or printing a file, with “Read files” and “Run
                commands” off. ticketd cannot switch that off.
              </p>
            )}
          </div>
          <div className="agent-field">
            <span className="agent-label">
              Limits
              <small>A step that reaches one fails</small>
            </span>
            <SettingsList>
              <LimitRow
                key={`turns-${taken}`}
                title="Turns"
                description={
                  codex
                    ? "Not applied with Codex"
                    : "How many turns one step may take"
                }
                most={MOST_TURNS}
                disabled={codex}
                value={draft.turn_limit}
                onSave={(turn_limit) => change({ turn_limit })}
              />
              <LimitRow
                key={`minutes-${taken}`}
                title="Minutes"
                description="How long one step may run"
                most={MOST_MINUTES}
                value={draft.time_limit_minutes}
                onSave={(time_limit_minutes) => change({ time_limit_minutes })}
              />
            </SettingsList>
          </div>
        </div>
      </div>
      <DialogShell
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete agent?"
        primaryLabel="Delete"
        primaryVariant="destructive"
        blockedReason={null}
        onSubmit={() => {
          setDeleting(false);
          onDelete();
        }}
      >
        <p className="chat-dialog-text">
          {title} is removed from the Agents list. This cannot be undone.
        </p>
      </DialogShell>
    </section>
  );
}
