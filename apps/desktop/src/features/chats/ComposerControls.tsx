import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { ChevronDown, LoaderCircle, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ChatState, HarnessSetting } from "@/features/chats/client";
import {
  changeHeld,
  changePending,
  shownOf,
  effortBars,
  labelOf,
  type Setting,
} from "@/features/chats/composer-settings";

type Option = HarnessSetting["options"][number];

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

function OptionLine({ option, lead }: { option: Option; lead?: ReactNode }) {
  return (
    <span className="chat-pick-option">
      <span className="chat-pick-option-line">
        {lead}
        <span>{option.label}</span>
        {option.is_default && <small>Default</small>}
      </span>
      {option.description && (
        <small className="chat-pick-option-note">{option.description}</small>
      )}
    </span>
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

/**
 * The composer's two harness triggers: model with its effort bars, and
 * permissions with its label. Both show what the harness reported and nothing
 * before it reports. A choice applies from the next message; while it is
 * pending the chevron is a spinner and the value shown is the one in effect.
 * Full access is never offered. Cmd/Ctrl+Shift+M opens model and effort.
 */
export function ComposerControls({
  chat,
  onChange,
  inputRef,
}: {
  chat: ChatState;
  onChange: (setting: Setting, value: string) => void;
  /** Where focus returns after a choice: the message box. */
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const [modelOpen, setModelOpen] = useState(false);
  const model = chat.settings?.model;
  const effort = chat.settings?.effort;
  const permission = chat.settings?.permission;
  const pickable = Boolean(model?.changeable || effort?.changeable);
  useEffect(() => {
    if (!pickable) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() === "m" &&
        event.shiftKey &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault();
        setModelOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pickable]);
  const backToBox = (event: Event) => {
    event.preventDefault();
    inputRef.current?.focus();
  };
  // ticketd holds a change made during a turn until the turn ends, so whatever the
  // harness's own timing, it applies from the person's next message.
  const NEXT_MESSAGE = "From your next message";

  const modelId = model ? shownOf(model) : null;
  const effortId = effort ? shownOf(effort) : null;
  const modelHeld = changeHeld(model) || changeHeld(effort);
  const bars = effort ? effortBars(effort.options, effortId) : null;
  const modelLabel = labelOf(model, modelId);
  const effortLabel = labelOf(effort, effortId);
  const modelName = [
    modelLabel && `Model ${modelLabel}`,
    effortLabel && `effort ${effortLabel}`,
  ]
    .filter(Boolean)
    .join(", ");
  const modelFace = (
    <>
      {(modelLabel || (!bars && effortLabel)) && (
        <span className="chat-control-label">{modelLabel || effortLabel}</span>
      )}
      {bars && <EffortGlyph {...bars} />}
    </>
  );
  const modelTrigger =
    (model || effort) &&
    (pickable ? (
      <DropdownMenu open={modelOpen} onOpenChange={setModelOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-control="model"
            aria-label={modelName}
            aria-keyshortcuts="Meta+Shift+M Control+Shift+M"
          >
            {modelFace}
            {changePending(model) || changePending(effort) ? (
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
          onCloseAutoFocus={backToBox}
        >
          {model?.changeable && (
            <DropdownMenuGroup>
              <DropdownMenuLabel>Model</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={modelId ?? ""}
                onValueChange={(value) => onChange("model", value)}
              >
                {model.options.map((option) => (
                  <DropdownMenuRadioItem
                    key={option.id}
                    value={option.id}
                    disabled={!option.allowed}
                  >
                    <OptionLine option={option} />
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          )}
          {model?.changeable && effort?.changeable && <DropdownMenuSeparator />}
          {effort?.changeable && (
            <DropdownMenuGroup>
              <DropdownMenuLabel>Effort</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={effortId ?? ""}
                onValueChange={(value) => onChange("effort", value)}
              >
                {effort.options.map((option) => {
                  const glyph = effortBars(effort.options, option.id, true);
                  return (
                    <DropdownMenuRadioItem
                      key={option.id}
                      value={option.id}
                      disabled={!option.allowed}
                    >
                      <OptionLine
                        option={option}
                        lead={
                          glyph ? (
                            <EffortGlyph {...glyph} />
                          ) : (
                            <span className="effort-glyph-slot" />
                          )
                        }
                      />
                    </DropdownMenuRadioItem>
                  );
                })}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          )}
          <DropdownMenuSeparator />
          <p className="chat-pick-note">{NEXT_MESSAGE}</p>
        </DropdownMenuContent>
      </DropdownMenu>
    ) : (
      <ReadOnly
        reason={
          model?.reason ??
          effort?.reason ??
          `Set in ${chat.harness.name}'s settings`
        }
      >
        <span className="sr-only">{modelName}</span>
        <span aria-hidden="true" className="contents">
          {modelFace}
        </span>
      </ReadOnly>
    ));

  const permissionId = permission ? shownOf(permission) : null;
  const permissionLabel = labelOf(permission, permissionId);
  const permissionFace = (
    <>
      <Shield aria-hidden />
      <span className="chat-control-label">{permissionLabel}</span>
    </>
  );
  const permissionTrigger =
    permission &&
    permissionLabel &&
    (permission.changeable ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-control=""
            aria-label={`Permissions: ${permissionLabel}`}
          >
            {permissionFace}
            {changePending(permission) ? (
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
          onCloseAutoFocus={backToBox}
        >
          <DropdownMenuLabel>Permissions</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={permissionId ?? ""}
            onValueChange={(value) => onChange("permission", value)}
          >
            {permission.options
              .filter((option) => option.allowed || option.id === permissionId)
              .map((option) => (
                <DropdownMenuRadioItem
                  key={option.id}
                  value={option.id}
                  disabled={!option.allowed}
                >
                  <OptionLine option={option} />
                </DropdownMenuRadioItem>
              ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <p className="chat-pick-note">
            Set for this Chat only. Your {chat.harness.name} settings are
            unchanged.
          </p>
        </DropdownMenuContent>
      </DropdownMenu>
    ) : (
      <ReadOnly
        reason={permission.reason ?? `Set in ${chat.harness.name}'s settings`}
      >
        <span className="sr-only">Permissions: {permissionLabel}</span>
        <span aria-hidden="true" className="contents">
          {permissionFace}
        </span>
      </ReadOnly>
    ));

  if (!modelTrigger && !permissionTrigger) return null;
  return (
    <div className="chat-controls" role="group" aria-label="Harness settings">
      {modelTrigger}
      {(modelHeld || changeHeld(permission)) && (
        <span className="chat-control-note">{NEXT_MESSAGE}</span>
      )}
      {permissionTrigger}
    </div>
  );
}
