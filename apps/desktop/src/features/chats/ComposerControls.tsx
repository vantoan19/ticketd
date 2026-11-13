import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { Check, ChevronDown, LoaderCircle, Shield } from "lucide-react";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
const NEXT_MESSAGE = "From your next message";
/** The segment that leaves effort to the harness when it names no default. */
const OWN = "";

/** "Default (recommended)" reads as "Default" in the trigger; the menu says it all. */
const shortName = (label: string) => label.replace(/\s*\([^)]*\)$/, "");

/** The harnesses ticketd hosts, as a Chat's picker lists the ones it doesn't use. */
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

/**
 * The composer's one picker for harness, model and effort (#368, after T3
 * Code): the trigger shows the harness's mark, the model and the effort bars;
 * its popover lists the harnesses, the chosen harness's models with their
 * descriptions and a Default tag, and the model's efforts as one row. What it
 * lists is only what the harness reported. A Chat keeps its harness: the
 * others show, and say to start a new Chat. Cmd/Ctrl+Shift+M opens it.
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
  pending = false,
  note,
  notice,
  onOpenChange,
  inputRef,
}: {
  harnesses: PickerHarness[];
  harnessId: string;
  /** A Chat keeps its harness; New Chat may switch. */
  locked: boolean;
  onHarness?: (id: string) => void;
  /** `runs_as` names what an alias row runs, for the trigger. */
  models: (SettingOption & { runs_as?: string | null | undefined })[];
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
  // New Chat hides its own copy of a harness's notice while the popover shows it.
  useEffect(() => onOpenChange?.(open), [open, onOpenChange]);
  const [viewed, setViewed] = useState(harnessId);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
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
    : "Default";
  const effortLabel =
    efforts.find((option) => option.id === effortId)?.label ?? "";
  const name = [
    harness?.name,
    `model ${modelLabel}`,
    effortLabel && `effort ${effortLabel}`,
  ]
    .filter(Boolean)
    .join(", ");
  const tab = harnesses.find((item) => item.id === viewed) ?? harness;
  const elsewhere = tab && tab.id !== harnessId;
  const segments = [
    ...(defaultEffort ? [] : [{ value: OWN, label: "Default" }]),
    ...efforts.map((option) => ({
      value: option.id,
      label: option.label,
      disabled: !changeable || !option.allowed,
    })),
  ];

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setViewed(harnessId);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-control="model"
          aria-label={name}
          aria-keyshortcuts="Meta+Shift+M Control+Shift+M"
        >
          <HarnessMark
            harness={harnessId}
            name={harness?.name ?? harnessId}
            dim={harness ? !harness.ready : false}
            decorative
          />
          <span className="chat-control-label">{modelLabel}</span>
          {bars && <EffortGlyph {...bars} />}
          {pending ? (
            <LoaderCircle size={12} className="chat-spin" aria-hidden />
          ) : (
            <ChevronDown aria-hidden />
          )}
        </Button>
      </PopoverTrigger>
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
        <div className="chat-picker">
          <div
            className="chat-picker-harnesses"
            role="tablist"
            aria-label="Harness"
          >
            {harnesses.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                className="chat-picker-harness"
                aria-selected={item.id === tab?.id}
                data-dim={item.ready ? undefined : ""}
                onClick={() => {
                  setViewed(item.id);
                  if (!locked) onHarness?.(item.id);
                }}
              >
                <HarnessMark
                  harness={item.id}
                  name={item.name}
                  dim={!item.ready}
                  decorative
                />
                <span>{item.name}</span>
                {!item.ready && item.word && <small>{item.word}</small>}
              </button>
            ))}
          </div>
          <div className="chat-picker-body" role="tabpanel">
            {elsewhere && locked ? (
              <p className="chat-picker-note">
                A Chat keeps its harness. Start a new Chat to use {tab.name}.
              </p>
            ) : tab && !tab.ready && notice ? (
              notice(tab.id)
            ) : (
              <>
                <p className="chat-picker-label" id="chat-picker-model">
                  Model
                </p>
                <RadioGroup.Root
                  className="chat-picker-models"
                  aria-labelledby="chat-picker-model"
                  value={shown?.id ?? OWN}
                  onValueChange={onModel}
                  disabled={!changeable}
                >
                  {models.length === 0 ? (
                    <RadioGroup.Item value={OWN} className="chat-picker-model">
                      <span className="chat-picker-model-line">
                        <span>Default</span>
                        <Check aria-hidden />
                      </span>
                      <small>
                        {empty ?? `${harness?.name ?? "It"} chooses its model.`}
                      </small>
                    </RadioGroup.Item>
                  ) : (
                    models.map((option) => (
                      <RadioGroup.Item
                        key={option.id}
                        value={option.id}
                        disabled={!option.allowed}
                        className="chat-picker-model"
                      >
                        <span className="chat-picker-model-line">
                          <span>{option.label}</span>
                          {/* Claude Code names its default row "Default" already. */}
                          {option.is_default &&
                            !option.label.startsWith("Default") && (
                              <small>Default</small>
                            )}
                          {option.id === shown?.id && <Check aria-hidden />}
                        </span>
                        {option.description && (
                          <small>{option.description}</small>
                        )}
                      </RadioGroup.Item>
                    ))
                  )}
                </RadioGroup.Root>
                {efforts.length > 0 && (
                  <div className="chat-picker-effort">
                    <p className="chat-picker-label" id="chat-picker-effort">
                      Effort
                    </p>
                    <SegmentedControl
                      compact
                      aria-labelledby="chat-picker-effort"
                      value={effortId ?? OWN}
                      onValueChange={(value) =>
                        onEffort(value === OWN ? null : value)
                      }
                      options={segments}
                    />
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
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-control=""
            readOnly
            aria-disabled="true"
          >
            {children}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{reason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
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
 * The small Permissions trigger beside the picker. `value` null before a
 * session is the harness's own setting, offered as "Default". Full access is
 * never offered.
 */
function PermissionPicker({
  setting,
  value,
  harness,
  onChange,
  inputRef,
  before = false,
}: {
  setting: HarnessSetting;
  value: string | null;
  harness: string;
  onChange: (value: string | null) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** New Chat: no session yet, so "Default" leaves the harness's own setting. */
  before?: boolean;
}) {
  const label = value ? labelOf(setting, value) : "Default";
  const face = (
    <>
      <Shield aria-hidden />
      <span className="chat-control-label">{label}</span>
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
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-control=""
          aria-label={`Permissions: ${label}`}
        >
          {face}
          {changePending(setting) ? (
            <LoaderCircle size={12} className="chat-spin" aria-hidden />
          ) : (
            <ChevronDown aria-hidden />
          )}
        </Button>
      </DropdownMenuTrigger>
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
        <DropdownMenuRadioGroup
          value={value ?? OWN}
          onValueChange={(next) => onChange(next === OWN ? null : next)}
        >
          {before && (
            <DropdownMenuRadioItem value={OWN}>
              <OptionLine
                option={{
                  id: OWN,
                  label: "Default",
                  description: `As your ${harness} settings say`,
                  is_default: false,
                  allowed: true,
                }}
              />
            </DropdownMenuRadioItem>
          )}
          {setting.options
            .filter((option) => option.allowed || option.id === value)
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
        <p className="chat-pick-note">
          Set for this Chat only. Your {harness} settings are unchanged.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A Chat's control row: the picker on its harness, whose models and efforts
 * are what the live session reported, and Permissions. Before the session
 * reports, the picker shows the harness and says so. A choice applies from the
 * next message; while it is pending the chevron is a spinner and the value
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
  const permission = chat.settings?.permission;
  const held =
    changeHeld(model) || changeHeld(effort) || changeHeld(permission);
  // The others only say to start a new Chat, so their state is not asked for.
  const tabs = [
    { id: chat.harness.id, name: chat.harness.name, ready: true },
    ...HARNESSES.filter((item) => item.id !== chat.harness.id),
  ];
  const changeable = Boolean(model?.changeable || effort?.changeable);
  const permissionId = permission ? shownOf(permission) : null;
  return (
    <div className="chat-controls" role="group" aria-label="Harness settings">
      <HarnessPicker
        harnesses={tabs}
        harnessId={chat.harness.id}
        locked
        models={model?.options ?? []}
        model={model ? shownOf(model) : null}
        efforts={effort?.options ?? []}
        effort={effort ? shownOf(effort) : null}
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
            : `${chat.harness.name} lists its models once the Chat's session starts.`
        }
        empty={
          model ? null : `${chat.harness.name} hasn't reported its model yet.`
        }
        pending={changePending(model) || changePending(effort)}
        note={NEXT_MESSAGE}
        inputRef={inputRef}
      />
      {held && <span className="chat-control-note">{NEXT_MESSAGE}</span>}
      {permission && permissionId && (
        <PermissionPicker
          setting={permission}
          value={permissionId}
          harness={chat.harness.name}
          onChange={(value) => value && onChange("permission", value)}
          inputRef={inputRef}
        />
      )}
    </div>
  );
}

/**
 * New Chat's control row, before any session: the picker over every harness,
 * with the models, efforts and permission modes each one reported to the host.
 * A harness that reported none offers only its Default and says so.
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
  harnessId: string;
  onHarness: (id: string) => void;
  /** What the chosen harness reported; `undefined` while it is being asked. */
  options: HarnessOptions | undefined;
  pick: Pick;
  onPick: (pick: Pick) => void;
  notice: (id: string) => ReactNode;
  onOpenChange?: (open: boolean) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const harness = harnesses.find((item) => item.id === harnessId);
  const name = harness?.name ?? harnessId;
  const permission = options?.permission;
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
