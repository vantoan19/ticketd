import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Check, ChevronDown, Clock, LoaderCircle, Shield } from "lucide-react";
import { RadioGroup } from "radix-ui";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Tooltip } from "@/components/ui/tooltip";
import type {
  ChatState,
  HarnessOptions,
  HarnessSetting,
  HarnessStatus,
  SettingOption,
} from "@/features/chats/client";
import {
  changeHeld,
  changePending,
  shownOf,
  effortBars,
  labelOf,
  type Setting,
} from "@/features/chats/composer-settings";
import { HarnessMark } from "@/features/chats/HarnessMark";
import {
  effortsOf,
  modelOf,
  startOf,
  withModel,
  type Pick,
} from "@/features/chats/harness-pick";

/** Rising bars, 2px wide on a 4px pitch, in whole pixels up to 12px. */
export function EffortGlyph({
  count,
  filled,
}: {
  count: number;
  filled: number;
}) {
  const width = 4 * count - 2;
  const left = (16 - width) / 2;
  const step = Math.max(1, Math.round(6 / Math.max(count - 1, 1)));
  return (
    <svg
      className="effort-glyph"
      width={16}
      height={16}
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      {Array.from({ length: count }, (_, index) => {
        const height = 12 - (count - 1 - index) * step;
        return (
          <rect
            key={index}
            data-on={index < filled ? "" : undefined}
            x={left + index * 4}
            y={14 - height}
            width={2}
            height={height}
          />
        );
      })}
    </svg>
  );
}

// ticketd holds a change made during a turn until the turn ends, so whatever the
// harness's own timing, it applies from the person's next message.
const NEXT_MESSAGE = "Applies from your next message.";
/** The segment that leaves effort to the harness when it names no default. */
const OWN = "";
/** Rows shown before "More models": the default, the current one, then the harness's order. */
const SHORT_LIST = 6;

/** "Default (recommended)" reads as "Default" in the trigger; the menu says it all. */
const shortName = (label: string) => label.replace(/\s*\([^)]*\)$/, "");

/** The harnesses ticketd hosts. */
const HARNESSES: PickerHarness[] = [
  { id: "claude-code", name: "Claude Code", ready: true },
  { id: "codex", name: "Codex", ready: true },
];

/** One harness as the picker's tabs show it. */
export type PickerHarness = {
  id: string;
  name: string;
  /** The one word said when it isn't ready ("Not signed in"). */
  word?: string | null;
  ready: boolean;
};

const pickerHarness = (status: HarnessStatus): PickerHarness => ({
  id: status.id,
  name: status.name,
  word: status.word?.word ?? null,
  ready: status.usable,
});

type ModelRow = SettingOption & { runs_as?: string | null | undefined };

const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * A row as the list names it: an alias row by the model it runs ("Opus 5.5"),
 * and no description that only repeats the name (LIVE-10). Only the harness's
 * default is tagged Default, once: a default that names no model reads
 * "Default" and needs no tag (LIVE2-4).
 */
function rowOf(option: ModelRow) {
  const name =
    option.runs_as ??
    (option.is_default ? shortName(option.label) : option.label);
  const description = option.description ?? "";
  const repeats =
    squash(description).includes(squash(name)) ||
    squash(description).includes(squash(option.label));
  return {
    name,
    tagged: option.is_default && squash(name) !== "default",
    description: repeats ? "" : description,
  };
}

/**
 * The rows the list shows: a row that only repeats what an alias runs is
 * hidden, and past six only the default, the current one and the first others
 * in the harness's order show until "More models".
 */
function shortList(
  models: ModelRow[],
  current: string | null,
  all: boolean,
): { rows: ModelRow[]; more: number } {
  const aliased = new Set(
    models.flatMap((option) => (option.runs_as ? [option.runs_as] : [])),
  );
  const rows = models.filter(
    (option) =>
      option.id === current || option.runs_as || !aliased.has(option.label),
  );
  if (all || rows.length <= SHORT_LIST) return { rows, more: 0 };
  const kept = new Set(
    rows
      .filter((option) => option.is_default || option.id === current)
      .map((option) => option.id),
  );
  for (const option of rows) {
    if (kept.size >= SHORT_LIST) break;
    kept.add(option.id);
  }
  const shown = rows.filter((option) => kept.has(option.id));
  return { rows: shown, more: rows.length - shown.length };
}

/**
 * The composer's one picker for harness, model and effort (#368, after T3
 * Code): the trigger shows the harness's mark, the model, the effort bars and
 * its word; its popover has the harness tabs, the effort row, then the
 * models. The popover keeps one height whatever the tab or loading state, so
 * nothing moves under the pointer. A Chat keeps its harness: only its tab
 * shows. Cmd/Ctrl+Shift+M opens it.
 */
export function HarnessPicker({
  harnesses,
  harnessId,
  locked,
  onHarness,
  models,
  model,
  efforts,
  effort,
  onModel,
  onEffort,
  changeable,
  reason,
  empty,
  loading = false,
  pending = false,
  note,
  notice,
  onOpenChange,
  inputRef,
  held = false,
}: {
  /**
   * A model or effort change waits for the turn to end: a small clock in the
   * trigger, with what applies next in its tooltip (CH-19).
   */
  held?: boolean;
  harnesses: PickerHarness[];
  harnessId: string;
  /** A Chat keeps its harness; New Chat may switch. */
  locked: boolean;
  onHarness?: (id: string) => void;
  /** `runs_as` names what an alias row runs, for the trigger. */
  models: ModelRow[];
  /** The model in effect or picked; `null` is the one the harness marks default. */
  model: string | null;
  efforts: SettingOption[];
  /** `null` is the model's default effort, else the harness's own setting. */
  effort: string | null;
  onModel: (id: string) => void;
  onEffort: (id: string | null) => void;
  changeable: boolean;
  /** Why model and effort cannot be changed, when they cannot. */
  reason?: string | null | undefined;
  /** Why the harness listed no models: only its Default is offered. */
  empty?: string | null | undefined;
  /** The harness is being asked for its models: skeleton rows hold the space. */
  loading?: boolean;
  /** A change was sent and not yet answered: the spinner. */
  pending?: boolean;
  note?: string | null | undefined;
  /** What to do about a harness that is not ready, shown when it is chosen. */
  notice?: ((id: string) => ReactNode) | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  /** Where focus returns after the popover closes: the message box. */
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  // New Chat hides its own copy of a harness's notice while the popover shows it.
  useEffect(() => onOpenChange?.(open), [open, onOpenChange]);
  const [viewed, setViewed] = useState(harnessId);
  const tabList = useRef<HTMLDivElement>(null);
  // The current model is in view when the list opens (CH-18).
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() =>
      body.current
        ?.querySelector<HTMLElement>('.chat-picker-model[data-state="checked"]')
        ?.scrollIntoView?.({ block: "nearest" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [open, viewed]);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (
        event.key.toLowerCase() === "m" &&
        event.shiftKey &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault();
        setOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const harness = harnesses.find((item) => item.id === harnessId);
  const shown =
    models.find((option) => option.id === model) ??
    models.find((option) => option.is_default);
  const defaultEffort = efforts.find((option) => option.is_default);
  const effortId = effort ?? defaultEffort?.id ?? null;
  const bars = effortBars(efforts, effortId);
  // The trigger names what will run: an alias row by the model it runs.
  const modelLabel = shown
    ? (shown.runs_as ?? shortName(shown.label))
    : loading
      ? ""
      : "Default model";
  // A model that takes effort always says which: "Default" when none was chosen.
  const effortLabel =
    efforts.find((option) => option.id === effortId)?.label ??
    (efforts.length > 0 && !effortId ? "Default" : "");
  const name = [
    harness?.name,
    `model ${modelLabel.replace(/ model$/, "") || "Default"}`,
    effortLabel && `effort ${effortLabel}`,
  ]
    .filter(Boolean)
    .join(", ");
  // A Chat keeps its harness: only its own tab (STATIC-14).
  const tabs = locked
    ? harnesses.filter((item) => item.id === harnessId)
    : harnesses;
  const tab = tabs.find((item) => item.id === viewed) ?? harness;
  const segments = [
    ...(defaultEffort ? [] : [{ value: OWN, label: "Default" }]),
    ...efforts.map((option) => ({
      value: option.id,
      label: option.label,
      disabled: !changeable || !option.allowed,
    })),
  ];
  const { rows, more } = shortList(models, shown?.id ?? null, all);
  const choose = (id: string) => {
    setViewed(id);
    if (!locked) onHarness?.(id);
  };
  // Left and Right move between harnesses, and choose the one they land on.
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((item) => item.id === tab?.id);
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % tabs.length
        : event.key === "ArrowLeft"
          ? (index - 1 + tabs.length) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : -1;
    const target = tabs[next];
    if (!target) return;
    event.preventDefault();
    choose(target.id);
    tabList.current
      ?.querySelector<HTMLButtonElement>(`[data-harness="${target.id}"]`)
      ?.focus();
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setViewed(harnessId);
          setAll(false);
        }
      }}
    >
      <Tooltip
        content={
          held
            ? `${modelLabel} · ${effortLabel || "Default"} from your next message`
            : name
        }
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-control="model"
            aria-label={held ? `${name}, from your next message` : name}
            aria-keyshortcuts="Meta+Shift+M Control+Shift+M"
          >
            <HarnessMark
              harness={harnessId}
              name={harness?.name ?? harnessId}
              dim={harness ? !harness.ready : false}
              decorative
            />
            {modelLabel ? (
              <span className="chat-control-label">{modelLabel}</span>
            ) : (
              <span
                className="chat-skeleton chat-control-skeleton"
                aria-hidden
              />
            )}
            {bars && <EffortGlyph {...bars} />}
            {effortLabel && (
              <span className="chat-control-effort">{effortLabel}</span>
            )}
            {held && !pending && (
              <Clock size={12} className="chat-control-held" aria-hidden />
            )}
            {pending ? (
              <LoaderCircle size={12} className="chat-spin" aria-hidden />
            ) : (
              <ChevronDown aria-hidden />
            )}
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent
        align="start"
        side="top"
        className="w-80"
        aria-label="Harness and model"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <div className="chat-picker" data-switch={locked ? undefined : ""}>
          <div
            ref={tabList}
            className="chat-picker-harnesses"
            role="tablist"
            aria-label="Harness"
            onKeyDown={onTabKey}
          >
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                data-harness={item.id}
                className="chat-picker-harness"
                aria-selected={item.id === tab?.id}
                tabIndex={item.id === tab?.id ? 0 : -1}
                data-dim={item.ready ? undefined : ""}
                onClick={() => choose(item.id)}
              >
                <HarnessMark
                  harness={item.id}
                  name={item.name}
                  dim={!item.ready}
                  decorative
                />
                <span className="chat-picker-harness-name shrink-0">
                  {item.name}
                </span>
                {!item.ready && item.word && <small>· {item.word}</small>}
              </button>
            ))}
          </div>
          <div ref={body} className="chat-picker-body" role="tabpanel">
            {tab && !tab.ready && notice ? (
              notice(tab.id)
            ) : (
              <>
                {(loading || efforts.length > 0) && (
                  <div className="chat-picker-effort">
                    <p className="chat-picker-label" id="chat-picker-effort">
                      Effort
                    </p>
                    {loading ? (
                      <span
                        className="chat-skeleton chat-picker-skeleton-row"
                        aria-hidden
                      />
                    ) : (
                      <SegmentedControl
                        compact
                        aria-labelledby="chat-picker-effort"
                        value={effortId ?? OWN}
                        onValueChange={(value) =>
                          onEffort(value === OWN ? null : value)
                        }
                        options={segments}
                      />
                    )}
                  </div>
                )}
                <p className="chat-picker-label" id="chat-picker-model">
                  Model
                </p>
                {loading ? (
                  <div
                    className="chat-picker-models"
                    role="status"
                    aria-label={empty ?? "Asking for its models…"}
                  >
                    {[0, 1, 2].map((index) => (
                      <span
                        key={index}
                        className="chat-skeleton chat-picker-skeleton-model"
                        aria-hidden
                      />
                    ))}
                  </div>
                ) : (
                  <div className="chat-picker-models">
                    <RadioGroup.Root
                      className="chat-picker-model-list"
                      aria-labelledby="chat-picker-model"
                      value={shown?.id ?? OWN}
                      onValueChange={onModel}
                      disabled={!changeable}
                    >
                      {models.length === 0 ? (
                        <RadioGroup.Item
                          value={OWN}
                          className="chat-picker-model"
                        >
                          <span className="chat-picker-model-line">
                            <span>Default</span>
                            <Check aria-hidden />
                          </span>
                          <small>
                            {empty ??
                              `${harness?.name ?? "It"} chooses its model.`}
                          </small>
                        </RadioGroup.Item>
                      ) : (
                        rows.map((option) => {
                          const row = rowOf(option);
                          return (
                            <RadioGroup.Item
                              key={option.id}
                              value={option.id}
                              disabled={!option.allowed}
                              className="chat-picker-model"
                            >
                              <span className="chat-picker-model-line">
                                <span>{row.name}</span>
                                {row.tagged && <small>Default</small>}
                                {option.id === shown?.id && (
                                  <Check aria-hidden />
                                )}
                              </span>
                              {row.description && (
                                <small>{row.description}</small>
                              )}
                            </RadioGroup.Item>
                          );
                        })
                      )}
                    </RadioGroup.Root>
                    {more > 0 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => setAll(true)}
                      >
                        More models ({more})
                      </Button>
                    )}
                  </div>
                )}
                {(reason ?? note) && (
                  <p className="chat-picker-note">{reason ?? note}</p>
                )}
              </>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** A trigger that cannot open, with why in its tooltip. */
function ReadOnly({
  reason,
  children,
}: {
  reason: string;
  children: ReactNode;
}) {
  return (
    <Tooltip content={reason}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-control="permission"
        readOnly
        aria-disabled="true"
      >
        {children}
      </Button>
    </Tooltip>
  );
}

type Option = HarnessSetting["options"][number];

function OptionLine({ option }: { option: Option }) {
  return (
    <span className="chat-pick-option">
      <span className="chat-pick-option-line">
        <span>{option.label}</span>
        {option.is_default && <small>Default</small>}
      </span>
      {option.description && (
        <small className="chat-pick-option-note">{option.description}</small>
      )}
    </span>
  );
}

/**
 * The small Permissions trigger beside the picker. It always names the mode
 * that applies ("Ask before edits"), never a bare "Default" (STATIC-13). Full
 * access is never offered. Below a 460px composer only its shield shows.
 */
function PermissionPicker({
  setting,
  value,
  harness,
  onChange,
  inputRef,
  before = false,
  held = false,
}: {
  /** The change waits for the turn to end: a clock and a tooltip (CH-19). */
  held?: boolean;
  setting: HarnessSetting;
  value: string | null;
  harness: string;
  onChange: (value: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** New Chat: no session yet, so no option is the session's own. */
  before?: boolean;
}) {
  const shown =
    value ?? setting.options.find((option) => option.is_default)?.id ?? null;
  const label = shown ? labelOf(setting, shown) : "Permissions";
  const face = (
    <>
      <Shield aria-hidden />
      <span className="chat-control-label chat-permission-label">{label}</span>
    </>
  );
  if (!setting.changeable)
    return (
      <ReadOnly reason={setting.reason ?? `Set in ${harness}'s settings`}>
        <span className="sr-only">Permissions: {label}</span>
        <span aria-hidden="true" className="contents">
          {face}
        </span>
      </ReadOnly>
    );
  return (
    <DropdownMenu>
      <Tooltip content={held ? `${label} from your next message` : null}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-control="permission"
            aria-label={
              held
                ? `Permissions: ${label}, from your next message`
                : `Permissions: ${label}`
            }
          >
            {face}
            {held && !changePending(setting) && (
              <Clock size={12} className="chat-control-held" aria-hidden />
            )}
            {changePending(setting) ? (
              <LoaderCircle size={12} className="chat-spin" aria-hidden />
            ) : (
              <ChevronDown aria-hidden />
            )}
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent
        align="start"
        side="top"
        className="w-72"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <DropdownMenuLabel>Permissions</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={shown ?? ""} onValueChange={onChange}>
          {setting.options
            .filter((option) => option.allowed || option.id === shown)
            .map((option) => (
              <DropdownMenuRadioItem
                key={option.id}
                value={option.id}
                disabled={!option.allowed}
              >
                <OptionLine
                  option={before ? { ...option, is_default: false } : option}
                />
              </DropdownMenuRadioItem>
            ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        {/* The whole explanation is visible: a menu note cannot take focus. */}
        <p className="chat-pick-note">
          This Chat only. Your {harness} settings are unchanged.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A Chat's control row: the picker on its harness, whose models and efforts
 * are what the live session reported, and Permissions. Before the session
 * reports, a Chat started here shows what New Chat started it with, so the
 * triggers do not change as the session starts (LIVE-6). A choice applies from
 * the next message; while it is pending the chevron is a spinner and the value
 * shown is the one in effect.
 */
export function ComposerControls({
  chat,
  onChange,
  inputRef,
}: {
  chat: ChatState;
  onChange: (setting: Setting, value: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const model = chat.settings?.model;
  const effort = chat.settings?.effort;
  const reported = chat.settings?.permission;
  const start = model || effort ? undefined : startOf(chat.id);
  const permission =
    reported ??
    (start?.pick.permission && start.options.permission
      ? {
          ...start.options.permission,
          current: start.pick.permission,
          changeable: false,
          reason: `From ${chat.harness.name}'s first message`,
        }
      : null);
  const tabs = [
    { id: chat.harness.id, name: chat.harness.name, ready: true },
    ...HARNESSES.filter((item) => item.id !== chat.harness.id),
  ];
  const changeable = Boolean(model?.changeable || effort?.changeable);
  const permissionId = permission ? shownOf(permission) : null;
  const starting = `${chat.harness.name} lists its models once the Chat's session starts.`;
  return (
    <div className="chat-controls" role="group" aria-label="Harness settings">
      <HarnessPicker
        harnesses={tabs}
        harnessId={chat.harness.id}
        locked
        models={model?.options ?? start?.options.models ?? []}
        model={model ? shownOf(model) : (start?.pick.model ?? null)}
        efforts={
          effort?.options ?? (start ? effortsOf(start.options, start.pick) : [])
        }
        effort={effort ? shownOf(effort) : (start?.pick.effort ?? null)}
        onModel={(id) => onChange("model", id)}
        onEffort={(id) => id && onChange("effort", id)}
        changeable={changeable}
        reason={
          model || effort
            ? changeable
              ? null
              : (model?.reason ??
                effort?.reason ??
                `Set in ${chat.harness.name}'s settings`)
            : starting
        }
        empty={
          model ? null : `${chat.harness.name} hasn't reported its model yet.`
        }
        pending={changePending(model) || changePending(effort)}
        note={NEXT_MESSAGE}
        held={changeHeld(model) || changeHeld(effort)}
        inputRef={inputRef}
      />
      {permission && permissionId && (
        <PermissionPicker
          setting={permission}
          held={changeHeld(permission)}
          value={permissionId}
          harness={chat.harness.name}
          onChange={(value) => onChange("permission", value)}
          inputRef={inputRef}
        />
      )}
    </div>
  );
}

/** Past this, a harness check that is still running says so in words (P10). */
const SLOW_CHECK_MS = 600;

/**
 * The picker's place while the harnesses are checked: a still skeleton, and
 * after 600ms the words "Checking harnesses…" beside the 12px spinner. It is
 * disabled, so it shows no chevron, and its tooltip says why (CH-14).
 */
function CheckingHarnesses() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), SLOW_CHECK_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div className="chat-controls" role="group" aria-label="Harness settings">
      <Tooltip content="Checking which harnesses are installed">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-control="model"
          aria-disabled="true"
          aria-label="Checking which harnesses are installed…"
        >
          {slow ? (
            <>
              <LoaderCircle size={12} className="chat-spin" aria-hidden />
              <span className="chat-control-label">Checking harnesses…</span>
            </>
          ) : (
            <>
              <span className="chat-skeleton chat-control-mark" aria-hidden />
              <span
                className="chat-skeleton chat-control-skeleton"
                aria-hidden
              />
            </>
          )}
        </Button>
      </Tooltip>
    </div>
  );
}

/**
 * New Chat's control row, before any session: the picker over every harness,
 * with the models, efforts and permission modes each one reported to the host.
 * A harness that reported none offers only its Default and says so. Before the
 * harnesses are known (`harnessId` null) the row holds its place with a
 * disabled picker, so nothing moves when they arrive (LIVE-11).
 */
export function NewChatControls({
  harnesses,
  harnessId,
  onHarness,
  options,
  pick,
  onPick,
  notice,
  onOpenChange,
  inputRef,
}: {
  harnesses: HarnessStatus[];
  harnessId: string | null;
  onHarness: (id: string) => void;
  /** What the chosen harness reported; `undefined` while it is being asked. */
  options: HarnessOptions | undefined;
  pick: Pick;
  onPick: (pick: Pick) => void;
  notice: (id: string) => ReactNode;
  onOpenChange?: (open: boolean) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  if (!harnessId) return <CheckingHarnesses />;
  const harness = harnesses.find((item) => item.id === harnessId);
  const name = harness?.name ?? harnessId;
  const permission = options?.permission;
  const loading = !options && Boolean(harness?.usable);
  return (
    <div className="chat-controls" role="group" aria-label="Harness settings">
      <HarnessPicker
        harnesses={harnesses.map(pickerHarness)}
        harnessId={harnessId}
        locked={false}
        onHarness={onHarness}
        models={options?.models ?? []}
        model={modelOf(options, pick)?.id ?? null}
        efforts={effortsOf(options, pick)}
        effort={pick.effort}
        onModel={(id) => onPick(withModel(options, pick, id))}
        onEffort={(id) => onPick({ ...pick, effort: id })}
        changeable={Boolean(options?.models.length)}
        loading={loading}
        empty={
          options
            ? `${name} didn't list its models${options.unavailable ? `: ${options.unavailable.replace(/\.$/, "")}` : ""}. It uses its default.`
            : `Asking ${name} for its models…`
        }
        notice={notice}
        onOpenChange={onOpenChange}
        inputRef={inputRef}
      />
      {permission?.changeable && (
        <PermissionPicker
          setting={permission}
          value={pick.permission}
          harness={name}
          before
          onChange={(value) => onPick({ ...pick, permission: value })}
          inputRef={inputRef}
        />
      )}
    </div>
  );
}
