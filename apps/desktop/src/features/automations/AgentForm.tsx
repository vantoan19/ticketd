import { useEffect, useId, useState, type ReactNode } from "react";
import { ArrowLeft, Ellipsis, Maximize2, Minimize2, X } from "lucide-react";
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

/**
 * The switches Codex does not follow. It reads files and runs any command inside
 * its own sandbox, and that sandbox always lets it write in the step's folder, so
 * with Codex these show as on and cannot be changed. The agent keeps its own
 * choices for Claude Code.
 */
const FIXED_ON_FOR_CODEX: ReadonlySet<keyof Tools> = new Set([
  "read_files",
  "edit_files",
  "run_commands",
]);

/** A whole number of at least 1, saved only while it is one. */
function LimitInput({
  label,
  value,
  disabled,
  onSave,
}: {
  label: string;
  value: number;
  disabled?: boolean;
  onSave: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  return (
    <Input
      type="number"
      min={1}
      step={1}
      className="h-8 w-18"
      aria-label={label}
      disabled={disabled}
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        const next = Number(event.target.value);
        if (Number.isInteger(next) && next >= 1) onSave(next);
      }}
      // Leaving the field with something that is not a limit shows the saved one.
      onBlur={() => setText(String(value))}
    />
  );
}

/**
 * One Automation agent, edited in place: every change is saved as it is made.
 * Mount it with the agent's id as `key`; it keeps the text being typed and does
 * not follow later changes to `agent`.
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
  onSave: (settings: AutomationAgentSettings) => void;
  onDelete: () => void;
}) {
  const client = useChatClient();
  const fieldId = useId();
  const [draft, setDraft] = useState<AutomationAgentSettings>(() =>
    // Parsing drops the id, leaving only what is sent back on a save.
    automationAgentSettingsSchema.parse(agent),
  );
  /** The command list as typed: one per line, blank lines and all. */
  const [commands, setCommands] = useState(
    agent.tools.allowed_commands.join("\n"),
  );
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

  const change = (patch: Partial<AutomationAgentSettings>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    onSave(next);
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
              onValueChange={(harness) =>
                change({ harness: harness as Harness })
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
              <ToolRow
                title="Turns"
                description={
                  codex
                    ? "Not applied with Codex"
                    : "How many turns one step may take"
                }
                control={
                  <LimitInput
                    label="Turns"
                    disabled={codex}
                    value={draft.turn_limit}
                    onSave={(turn_limit) => change({ turn_limit })}
                  />
                }
              />
              <ToolRow
                title="Minutes"
                description="How long one step may run"
                control={
                  <LimitInput
                    label="Minutes"
                    value={draft.time_limit_minutes}
                    onSave={(time_limit_minutes) =>
                      change({ time_limit_minutes })
                    }
                  />
                }
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
