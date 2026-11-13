import {
  Fragment,
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import {
  ArrowDown,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  FilePlus2,
  FileText,
  Info,
  LoaderCircle,
  MessageSquareText,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Reference } from "@/components/ui/reference";
import { StatusDot } from "@/components/ui/status-dot";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useCopy } from "@/components/ui/use-copy";
import { MarkdownDocument } from "@/features/markdown/MarkdownDocument";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import type {
  ChatState,
  RecordChange,
  Step,
  TranscriptItem,
} from "@/features/chats/client";
import {
  FilesSummary,
  PlanCard,
  ReasoningRow,
} from "@/features/chats/TurnReports";
import {
  binarySize,
  duration,
  elapsed,
  receiptLine,
  stepWords,
  targetLines,
  turns,
  type Turn,
  type TurnRow,
} from "@/features/chats/model";
import { OutputBox } from "@/features/chats/OutputBox";
import { ReceiptRow } from "@/features/chats/ReceiptRow";
import { useReading } from "@/features/chats/use-transcript-scroll";

type Of<K extends TranscriptItem["kind"]> = Extract<
  TranscriptItem,
  { kind: K }
>;

/** What transcript items can ask of the Chat that owns them. Keep the object stable. */
export type TranscriptActions = {
  saveAsDocument: (response: Of<"response">) => void;
  /** Saves a plan its turn left unfinished, as a checklist. */
  savePlan: (plan: Of<"plan">) => void;
  /** Opens a file the turn changed; rejects with the reason it could not. */
  openFile: (path: string) => Promise<void>;
};

const DELIVERY_CAPTION = {
  // Saved here is not the same as received there.
  sending: "Sending…",
  delivered: "",
  not_sent: "Not sent",
  uncertain: "Not confirmed",
  set_aside: "Not confirmed · set aside",
} as const;

function UserMessage({ item }: { item: Of<"user"> }) {
  const caption = DELIVERY_CAPTION[item.delivery];
  return (
    <>
      <div
        className="chat-you"
        data-unsent={item.delivery === "delivered" ? undefined : ""}
      >
        <span className="sr-only">You: </span>
        {item.text}
      </div>
      {caption && <div className="chat-caption">{caption}</div>}
    </>
  );
}

function Response({
  item,
  harness,
  readOnly,
  actions,
}: {
  item: Of<"response">;
  harness: string;
  readOnly: boolean;
  actions: TranscriptActions;
}) {
  const { copied, error, copy } = useCopy();
  return (
    <div className="chat-turn">
      <div className="chat-ai">
        <span className="sr-only">{harness}: </span>
        <MarkdownDocument source={item.text} />
      </div>
      {item.state === "partial" && (
        <p className="chat-fine">
          Incomplete. ticketd closed before the rest of this response was saved.
        </p>
      )}
      {item.state === "complete" && (
        <div className="chat-actions">
          <IconButton
            label="Copy response"
            onClick={() => void copy("Response", item.text)}
          >
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          </IconButton>
          {!readOnly && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => actions.saveAsDocument(item)}
            >
              <FilePlus2 aria-hidden /> Save as Document
            </Button>
          )}
          <span className="chat-fine" role="status">
            {copied && "Copied"}
            {error}
          </span>
        </div>
      )}
    </div>
  );
}

/** The current time, ticking each second while `on`. */
function useNow(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [on]);
  return now;
}

/** What an opened step row holds: its command and output, its targets or its output. */
function StepDetail({
  id,
  step,
  harness,
}: {
  id: string;
  step: Step;
  harness: string;
}) {
  const targets = step.targets ?? [];
  const words = stepWords(step);
  const command = step.kind === "run" ? step.command : undefined;
  return (
    <div className="chat-steplist" id={command ? undefined : id}>
      {command ? (
        <OutputBox id={id} command={command} output={step.output} />
      ) : targets.length > 2 ? (
        <ul>
          {targets.map((target, index) => (
            <li key={index}>
              <code>{target.text}</code>
              {target.scope && (
                <>
                  {" "}
                  in <code>{target.scope}</code>
                </>
              )}
              {target.lines && <small>{targetLines(target)}</small>}
            </li>
          ))}
        </ul>
      ) : (
        step.output && <pre className="chat-out">{step.output}</pre>
      )}
      {words.detail && <p className="chat-fine">{words.detail}</p>}
      {step.result && <p className="chat-fine">{step.result}</p>}
      {step.truncated && (
        <p className="chat-fine">
          Truncated: ticketd keeps the last{" "}
          {binarySize(step.truncated.kept_bytes)} of{" "}
          {binarySize(step.truncated.total_bytes)}. {harness} saw all of it.
        </p>
      )}
    </div>
  );
}

/** One 28px line: `[icon] words`, then a chevron when it opens. */
function RowLine({
  icon,
  children,
}: {
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <span className="chat-row-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="chat-step-words">{children}</span>
    </>
  );
}

/**
 * One step: `[icon] Verb target · suffix`. While it runs, and the view is live
 * rather than replaying history, the spinner takes the icon's slot and a clock
 * counts from the host's start time. `decision` is the answered approval the step
 * waited on, shown as its tooltip and description.
 */
export function StepRow({
  step,
  harness,
  decision,
  live,
}: {
  step: Step;
  harness: string;
  decision?: string | undefined;
  live: boolean;
}) {
  const [open, setOpen] = useState(false);
  const reading = useReading();
  const id = useId();
  const described = useId();
  const words = stepWords(step);
  const running = live && step.state === "running";
  const now = useNow(running && Boolean(step.started_at));
  const started = step.started_at ? Date.parse(step.started_at) : NaN;
  const clock =
    running && now - started >= 1000 ? duration(now - started) : undefined;
  const line = (
    <RowLine
      icon={
        running ? <LoaderCircle size={12} className="chat-spin" /> : undefined
      }
    >
      {words.parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 && " "}
          {part.code ? <code>{part.text}</code> : part.text}
        </Fragment>
      ))}
      {words.suffix ? (
        <>
          <span aria-hidden> · </span>
          <span data-outcome={words.suffix.outcome ? "" : undefined}>
            {words.suffix.text}
          </span>
        </>
      ) : (
        clock && <span aria-hidden="true"> · {clock}</span>
      )}
      {decision && (
        <span id={described} className="sr-only">
          {decision}
        </span>
      )}
    </RowLine>
  );
  const detail =
    (step.kind === "run" && Boolean(step.command)) ||
    Boolean(step.output) ||
    (step.targets?.length ?? 0) > 2 ||
    Boolean(words.detail || step.result || step.truncated);
  const row = detail ? (
    <button
      type="button"
      className="chat-steps"
      data-anchor=""
      aria-expanded={open}
      aria-controls={open ? id : undefined}
      aria-label={words.label}
      aria-describedby={decision ? described : undefined}
      onClick={(event) => {
        reading.keep(event.currentTarget);
        setOpen(!open);
      }}
    >
      {line}
      {open ? (
        <ChevronDown size={14} className="chat-chevron" aria-hidden />
      ) : (
        <ChevronRight size={14} className="chat-chevron" aria-hidden />
      )}
    </button>
  ) : (
    <div
      className="chat-steps"
      data-anchor=""
      // A row carrying a decision takes focus, so its tooltip shows from the keyboard.
      tabIndex={decision ? 0 : undefined}
      aria-describedby={decision ? described : undefined}
    >
      {line}
    </div>
  );
  return (
    <>
      {decision ? (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>{row}</TooltipTrigger>
            <TooltipContent side="right">{decision}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        row
      )}
      {open && <StepDetail id={id} step={step} harness={harness} />}
    </>
  );
}

/** A record the agent changed, as a step row: verb first, the reference in mono. */
function RecordStep({ change }: { change: RecordChange }) {
  const [icon, words] =
    change.kind === "status"
      ? [
          <StatusIcon key="icon" status={change.to} decorative />,
          <>
            Moved <Reference>{change.reference}</Reference> to {change.to}
          </>,
        ]
      : change.kind === "update"
        ? [
            <MessageSquareText key="icon" size={16} />,
            <>
              Posted an update on <Reference>{change.reference}</Reference>
            </>,
          ]
        : [
            <FileText key="icon" size={16} />,
            <>Created the Document “{change.title}”</>,
          ];
  return (
    <div className="chat-steps" data-anchor="">
      <RowLine icon={icon}>{words}</RowLine>
    </div>
  );
}

/** An answered question or an expired request, in regular weight with no fill. */
function Receipt({ item }: { item: Of<"request"> }) {
  return (
    <div className="chat-steps chat-receipt" data-anchor="">
      <RowLine
        icon={
          item.state === "expired" ? <Clock size={16} /> : <Check size={16} />
        }
      >
        {receiptLine(item)}
      </RowLine>
    </div>
  );
}

/** What ticketd says, not the harness: a smaller muted line with a marker. */
function Note({ item }: { item: Of<"marker"> }) {
  return (
    <p className="chat-line chat-note" data-anchor="">
      <Info size={14} aria-hidden />
      <span>
        <span className="sr-only">ticketd: </span>
        {item.message}
      </span>
    </p>
  );
}

function Row({
  row,
  harness,
  readOnly,
  actions,
  live,
}: {
  row: TurnRow;
  harness: string;
  readOnly: boolean;
  actions: TranscriptActions;
  live: boolean;
}) {
  switch (row.kind) {
    case "step":
      return (
        <StepRow
          step={row.step}
          harness={harness}
          decision={row.decision}
          live={live}
        />
      );
    case "response":
      return (
        <div className="chat-turn-response" data-anchor="">
          <Response
            item={row.item}
            harness={harness}
            readOnly={readOnly}
            actions={actions}
          />
        </div>
      );
    case "record":
      return <RecordStep change={row.change} />;
    case "receipt":
      return <Receipt item={row.item} />;
    case "note":
      return <Note item={row.item} />;
    case "reasoning":
      return <ReasoningRow item={row.item} />;
    case "plan":
      return (
        <PlanCard
          item={row.item}
          readOnly={readOnly}
          onSave={actions.savePlan}
        />
      );
  }
}

/** Fold toggles the person made, by Chat and turn; they win for the session. */
const toggles = new Map<string, boolean>();

/**
 * A turn. While it runs its rows show as they come. Once it ends they fold under
 * one muted row, and the final response and end marker stay outside. A turn the
 * person is reading in, or that holds focus, folds once it is out of view; a stop
 * that was not confirmed stays open.
 */
function TurnView({
  turn,
  chatId,
  harness,
  readOnly,
  actions,
  live,
}: {
  turn: Turn;
  chatId: string;
  harness: string;
  readOnly: boolean;
  actions: TranscriptActions;
  live: boolean;
}) {
  const key = `${chatId}:${turn.key}`;
  const [toggled, setToggled] = useState(() => toggles.get(key));
  const reading = useReading();
  const part = useRef<HTMLDivElement>(null);
  const rowButton = useRef<HTMLButtonElement>(null);
  const bodyId = useId();
  const rowId = useId();
  // A turn that ends in view of someone reading, or with focus inside, stays open
  // until it leaves the view. `settled` says the end has been looked at.
  const [settled, setSettled] = useState(!turn.live);
  const [held, setHeld] = useState(false);
  useLayoutEffect(() => {
    if (turn.live || settled) return;
    const element = part.current;
    const scroller = element?.closest(".chat-scroll");
    const readingHere =
      element &&
      scroller &&
      (element.contains(document.activeElement) ||
        (!reading.follows() &&
          element.getBoundingClientRect().bottom >
            scroller.getBoundingClientRect().top &&
          element.getBoundingClientRect().top <
            scroller.getBoundingClientRect().bottom));
    setHeld(Boolean(readingHere));
    setSettled(true);
  }, [reading, settled, turn.live]);
  useEffect(() => {
    const element = part.current;
    const scroller = element?.closest(".chat-scroll");
    if (!held || !element || typeof IntersectionObserver === "undefined")
      return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry && !entry.isIntersecting) setHeld(false);
      },
      { root: scroller ?? null },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [held]);
  const folds = turn.rows.some((row) => row.kept !== true);
  const showRow = !turn.live && folds;
  const open = !showRow || (toggled ?? (turn.unconfirmed || !settled || held));
  const toggle = () => {
    const next = !open;
    toggles.set(key, next);
    setToggled(next);
    // The row stays where the reader clicked it.
    if (rowButton.current) reading.keep(rowButton.current);
    // Collapsing with focus inside leaves focus on the row.
    if (!next) rowButton.current?.focus();
  };
  const rowLive = live && turn.live;
  const changes = turn.rows.flatMap((row) =>
    row.kind === "record" ? [row.change] : [],
  );
  const rows = (only: (row: TurnRow) => boolean) =>
    turn.rows
      .filter(only)
      .map((row) => (
        <Row
          key={row.key}
          row={row}
          harness={harness}
          readOnly={readOnly}
          actions={actions}
          live={rowLive}
        />
      ));
  return (
    <>
      <div
        ref={part}
        className="chat-turnpart"
        data-anchor=""
        data-seen={turn.ids.at(-1)}
      >
        {showRow && (
          <button
            ref={rowButton}
            id={rowId}
            type="button"
            className="chat-fold"
            aria-expanded={open}
            aria-controls={open ? bodyId : undefined}
            onClick={toggle}
          >
            <span>{turn.label}</span>
            {open ? (
              <ChevronDown size={14} aria-hidden />
            ) : (
              <ChevronRight size={14} aria-hidden />
            )}
          </button>
        )}
        {open ? (
          <div
            id={showRow ? bodyId : undefined}
            className="chat-turn-rows"
            data-folded={showRow ? "" : undefined}
            role={showRow ? "group" : undefined}
            aria-labelledby={showRow ? rowId : undefined}
          >
            {rows(() => true)}
          </div>
        ) : (
          // Collapsed, receipts and notes sit under the turn row in order.
          turn.rows.some((row) => row.kept === true) && (
            <div className="chat-turn-rows">
              {rows((row) => row.kept === true)}
            </div>
          )
        )}
      </div>
      {turn.plan && (
        <div data-anchor="">
          <PlanCard
            item={turn.plan}
            readOnly={readOnly}
            onSave={actions.savePlan}
          />
        </div>
      )}
      {turn.final && (
        <div data-anchor="">
          <Response
            item={turn.final}
            harness={harness}
            readOnly={readOnly}
            actions={actions}
          />
        </div>
      )}
      {/* Below the response, in order: the stop marker, then #367's changed
          files row, then #364's records row. */}
      {turn.marker && (
        <div className="chat-below" data-anchor="">
          <StopMarker item={turn.marker} harness={harness} />
        </div>
      )}
      {turn.files && (
        <div className="chat-below" data-anchor="">
          <FilesSummary
            item={turn.files}
            commandEdits={turn.commandEdits ?? false}
            onOpen={actions.openFile}
          />
        </div>
      )}
      {!turn.live && changes.length > 0 && (
        <div className="chat-below" data-anchor="">
          {/* Never folded; "N more" opens the fold, where each is a step row. */}
          <ReceiptRow
            changes={changes}
            onMore={() => {
              if (!open) toggle();
            }}
          />
        </div>
      )}
    </>
  );
}

function markerText(item: Of<"marker">, harness: string) {
  const detail = item.message ? ` ${item.message}` : "";
  switch (item.reason) {
    case "stopped":
      return `You stopped this turn. Edits already made are kept.${detail}`;
    case "quit":
      return `Stopped when ticketd quit. Edits already made are kept.${detail}`;
    case "stop_unconfirmed":
      return `ticketd asked ${harness} to stop but it didn't confirm. It may still be running.${detail}`;
    case "failed":
      return `This turn failed.${detail || ` ${harness} gave no reason.`} What it finished before that is kept.`;
    case "note":
      return item.message ?? "";
  }
}

function StopMarker({
  item,
  harness,
}: {
  item: Of<"marker">;
  harness: string;
}) {
  return (
    <p className="chat-line">
      {/* Filled, the stop sign does not read as an empty checkbox. */}
      <Square size={12} fill="currentColor" aria-hidden />
      <span>{markerText(item, harness)}</span>
    </p>
  );
}

const SESSION_HISTORY = {
  last_response: () => "the last response",
  last_messages: (count: number) => `the last ${count} messages`,
  all: () => "the whole conversation",
  picked: (count: number) =>
    `${count} picked ${count === 1 ? "message" : "messages"}`,
} as const;

/** An item outside any turn: your message, a session divider, a lone marker. */
const Item = memo(function Item({
  item,
  harness,
  readOnly,
  actions,
}: {
  item: TranscriptItem;
  harness: string;
  readOnly: boolean;
  actions: TranscriptActions;
}) {
  switch (item.kind) {
    case "reasoning":
      return <ReasoningRow item={item} />;
    case "plan":
      // While its turn runs, the plan lives in the activity dock.
      return (
        <PlanCard item={item} readOnly={readOnly} onSave={actions.savePlan} />
      );
    case "files":
      return (
        <FilesSummary
          item={item}
          commandEdits={false}
          onOpen={actions.openFile}
        />
      );
    case "user":
      return <UserMessage item={item} />;
    case "response":
      return (
        <Response
          item={item}
          harness={harness}
          readOnly={readOnly}
          actions={actions}
        />
      );
    case "session":
      return (
        <div className="chat-divider" role="separator">
          Fresh session · started with{" "}
          {SESSION_HISTORY[item.history](item.count)}
        </div>
      );
    case "marker":
      return item.reason === "note" ? (
        <Note item={item} />
      ) : (
        <StopMarker item={item} harness={harness} />
      );
    default:
      return null;
  }
});

/**
 * The live line: the spinner and what the turn is doing, shown only while no step
 * row runs. `since` counts "Working for 1m 32s" from the turn's start; `fromShown`
 * counts from when the line appeared, for a phase the host gives no start time for.
 * The clock is not read out: one polite status says when a turn starts, waits and
 * ends.
 */
function WorkingLine({
  label,
  since,
  fromShown = false,
  spinner = true,
}: {
  label: string;
  since?: string;
  fromShown?: boolean;
  spinner?: boolean;
}) {
  const [shown] = useState(() => Date.now());
  const now = useNow(Boolean(since) || fromShown);
  const started = since ? Date.parse(since) : NaN;
  return (
    <div className="chat-working">
      {spinner && <LoaderCircle size={12} className="chat-spin" aria-hidden />}
      <span>
        {since ? (
          Number.isNaN(started) || now - started < 1000 ? (
            `${label}…`
          ) : (
            <>
              {label} for{" "}
              <span aria-hidden="true">{duration(now - started)}</span>
            </>
          )
        ) : (
          label
        )}
        {fromShown && <span aria-hidden="true"> · {elapsed(now - shown)}</span>}
      </span>
    </div>
  );
}

/** Above the first item that arrived while the reader was away. */
function NewMarker({ markerRef }: { markerRef: Ref<HTMLDivElement> }) {
  return (
    <div
      ref={markerRef}
      className="chat-divider"
      role="separator"
      aria-label="New since you left"
    >
      <span className="chat-new-marker">
        <StatusDot tone="unread" />
        New
      </span>
    </div>
  );
}

/**
 * "Jump to latest", centred above the dock whenever the reader is not following.
 * From the keyboard it also moves focus to the message box.
 */
export function JumpToLatest({
  shown,
  onJump,
}: {
  shown: boolean;
  onJump: (fromKeyboard: boolean) => void;
}) {
  return (
    <div
      className="chat-jump"
      data-shown={shown ? "" : undefined}
      inert={!shown}
    >
      <Button
        variant="outline"
        size="sm"
        // A click from the keyboard has no pointer position.
        onClick={(event) => onJump(event.detail === 0)}
      >
        <ArrowDown aria-hidden /> Jump to latest
      </Button>
    </div>
  );
}

const excerpt = (text: string) =>
  text.length > 60 ? `${text.slice(0, 60)}…` : text;

/**
 * The conversation, in the order things happened, read result-first: each turn's
 * work folds under one row once it ends. In pick mode it becomes the history
 * picker of "Resume in a fresh session": only messages, each with a checkbox.
 * `newFrom` is the first item that arrived while the reader was away.
 */
export function Transcript({
  chat,
  items,
  actions,
  picked,
  onPick,
  newFrom,
  markerRef,
  contentRef,
}: {
  chat: ChatState;
  items: TranscriptItem[];
  actions: TranscriptActions;
  /** Set while picking history; holds the chosen message ids. */
  picked?: ReadonlySet<string> | undefined;
  onPick?: (id: string, include: boolean) => void;
  newFrom?: string | undefined;
  markerRef?: Ref<HTMLDivElement>;
  contentRef?: Ref<HTMLDivElement>;
}) {
  const harness = chat.harness.name;
  const readOnly = chat.retention === "trashed";
  if (picked)
    return (
      <div className="chat-col" ref={contentRef}>
        {items.map(
          (item) =>
            (item.kind === "user" || item.kind === "response") && (
              <div key={item.id} className="chat-pickrow">
                <input
                  type="checkbox"
                  checked={picked.has(item.id)}
                  aria-label={
                    item.kind === "user"
                      ? `Include your message: ${excerpt(item.text)}`
                      : `Include the reply: ${excerpt(item.text)}`
                  }
                  onChange={(event) => onPick?.(item.id, event.target.checked)}
                />
                <div>
                  <Item
                    item={item}
                    harness={harness}
                    readOnly
                    actions={actions}
                  />
                </div>
              </div>
            ),
        )}
      </div>
    );
  const parts = turns(items, chat);
  const live = !chat.catching_up;
  const stepRuns = parts.some(
    (part) =>
      part.kind === "turn" &&
      part.turn.live &&
      part.turn.rows.some(
        (row) => row.kind === "step" && row.step.state === "running",
      ),
  );
  const working = chat.activity === "working";
  return (
    <div className="chat-col" ref={contentRef}>
      {parts.map((part) => {
        const marker = newFrom !== undefined &&
          (part.kind === "turn"
            ? part.turn.ids.includes(newFrom)
            : part.item.id === newFrom) && (
            <NewMarker key="new" markerRef={markerRef ?? null} />
          );
        return part.kind === "turn" ? (
          <Fragment key={part.turn.key}>
            {marker}
            <TurnView
              turn={part.turn}
              chatId={chat.id}
              harness={harness}
              readOnly={readOnly}
              actions={actions}
              live={live}
            />
          </Fragment>
        ) : (
          <Fragment key={part.item.id}>
            {marker}
            <div className="chat-part" data-anchor="" data-seen={part.item.id}>
              <Item
                item={part.item}
                harness={harness}
                readOnly={readOnly}
                actions={actions}
              />
            </div>
          </Fragment>
        );
      })}
      {chat.catching_up && (
        <>
          <div className="chat-skel chat-skel-long" aria-hidden="true" />
          <div className="chat-skel chat-skel-short" aria-hidden="true" />
        </>
      )}
      {chat.catching_up ? (
        <WorkingLine label="Catching up…" />
      ) : chat.activity === "waiting" ? (
        <WorkingLine label="Waiting for you" spinner={false} />
      ) : working && chat.stopping ? (
        <WorkingLine label="Stopping…" spinner={!stepRuns} />
      ) : working && chat.opening ? (
        <WorkingLine
          key="opening"
          label={
            chat.opening === "resume"
              ? `Resuming the ${harness} session…`
              : `Starting ${harness}…`
          }
          fromShown
        />
      ) : (
        // After an unconfirmed stop the open turn row and the notice say it.
        working &&
        !stepRuns &&
        !parts.some((part) => part.kind === "turn" && part.turn.unconfirmed) &&
        (chat.doing ? (
          <WorkingLine label={chat.doing.label} since={chat.doing.since} />
        ) : (
          <WorkingLine label="Working…" />
        ))
      )}
    </div>
  );
}
