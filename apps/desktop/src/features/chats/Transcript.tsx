import {
  Fragment,
  createContext,
  memo,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
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
  Eye,
  FilePlus2,
  FileText,
  Globe,
  Info,
  LoaderCircle,
  MessageSquareText,
  Pencil,
  Search,
  Square,
  SquarePlus,
  Terminal,
  Trash2,
  Wrench,
  type LucideIcon,
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
import { DocumentNavigation } from "@/features/documents/navigation";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import {
  useChatClient,
  type ChatState,
  type RecordChange,
  type Step,
  type TranscriptItem,
  type ItemOf,
  type LinkedRecord,
} from "@/features/chats/client";
import {
  FilesSummary,
  PlanCard,
  ReasoningRow,
} from "@/features/chats/TurnReports";
import {
  binarySize,
  duration,
  plainOutput,
  receiptLine,
  stepWords,
  targetLines,
  turns,
  workedFor,
  isLive,
  recordNamer,
  type RecordName,
  type Turn,
  type TurnRow,
  goneWords,
} from "@/features/chats/model";
import { FileName } from "@/features/chats/FileName";
import {
  ChatFilesContext,
  SentLinksContext,
  shownNames,
} from "@/features/chats/files";
import { sentParts } from "@/features/chats/composer-mentions";
import { TicketNavigation } from "@/features/tickets/navigation";
import { ProjectNavigation } from "@/features/documents/navigation";
import { ImageTiles } from "@/features/chats/ImageTiles";
import { OutputBox } from "@/features/chats/OutputBox";
import { ReceiptRow } from "@/features/chats/ReceiptRow";
import { useReading } from "@/features/chats/use-transcript-scroll";

/** What transcript items can ask of the Chat that owns them. Keep the object stable. */
export type TranscriptActions = {
  saveAsDocument: (response: ItemOf<"response">) => void;
  /** Saves a plan its turn left unfinished, as a checklist. */
  savePlan: (plan: ItemOf<"plan">) => void;
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

/**
 * The session is opening: its working line says "Starting…", so a message's
 * own "Sending…" is not said too (LIVE-6, one status row).
 */
const OpeningContext = createContext(false);

/** "10:44": when your message was sent, as the hover line says it. */
const sentAt = (stamp: string) => {
  const date = new Date(stamp);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      });
};

/**
 * Your message, exactly as sent, on the right. Past four lines it folds behind
 * Show more. Its time and Copy show on hover or focus.
 */
/** A record a sent message mentions: a link, or its name and "(in Trash)". */
function SentMention({
  record,
  text,
  trashed,
}: {
  record: LinkedRecord;
  text: string;
  trashed: boolean;
}) {
  const openTicket = useContext(TicketNavigation);
  const openDocument = useContext(DocumentNavigation);
  const openProject = useContext(ProjectNavigation);
  const ticket = record.kind === "ticket";
  if (trashed)
    return (
      <>
        {ticket ? <code className="chat-mono">{text}</code> : text}
        {goneWords("trashed")}
      </>
    );
  const open = () =>
    record.kind === "ticket"
      ? openTicket?.(record.reference)
      : record.kind === "document"
        ? openDocument?.(record.id)
        : openProject?.(record.id);
  return (
    // Inline text, not a Button: it reads as a link inside the message.
    <button
      type="button"
      className={
        ticket ? "chat-records-ref" : "chat-records-ref chat-records-name"
      }
      onClick={open}
    >
      {text}
    </button>
  );
}

/** A sent message's own words: its quotes as quotes, its mentions as links. */
function SentText({ text }: { text: string }) {
  const { links, trashed } = useContext(SentLinksContext);
  const { quotes, parts } = sentParts(text, links);
  return (
    <>
      {quotes.map((quote, index) => (
        <blockquote key={index} className="chat-quote">
          <span className="chat-quote-source">{quote.source}</span>
          <span className="chat-quote-text">{quote.text}</span>
        </blockquote>
      ))}
      {parts.map((part, index) =>
        part.record ? (
          <SentMention
            key={index}
            record={part.record}
            text={part.text}
            trashed={trashed.includes(part.record.id)}
          />
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}

function UserMessage({ item }: { item: ItemOf<"user"> }) {
  const opening = useContext(OpeningContext);
  const caption =
    opening && item.delivery === "sending"
      ? ""
      : DELIVERY_CAPTION[item.delivery];
  const { copied, error, copy } = useCopy();
  const text = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [more, setMore] = useState(false);
  // Measured again whenever the message's width changes: a pane narrowed after
  // the message was shown clamps it, and then it needs Show more. A clamped box
  // reports only its four lines as its scroll height in WebKit and Chrome, so the
  // full height is read with the clamp lifted for the measurement.
  useLayoutEffect(() => {
    const box = text.current;
    if (!box || more) return;
    const measure = () => {
      const clamped = box.clientHeight;
      box.removeAttribute("data-clamped");
      const full = box.scrollHeight;
      box.setAttribute("data-clamped", "");
      setLong(full > clamped + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [item.text, more]);
  const time = sentAt(item.at);
  return (
    <div className="chat-you-part">
      {item.images && item.images.length > 0 && (
        <ImageTiles images={item.images} />
      )}
      <div className="chat-you">
        <div ref={text} data-clamped={more ? undefined : ""}>
          <span className="sr-only">You: </span>
          <SentText text={item.text} />
        </div>
      </div>
      {long && (
        <Button
          variant="ghost"
          size="xs"
          className="-mt-1 -mr-2"
          aria-expanded={more}
          onClick={() => setMore(!more)}
        >
          {more ? "Show less" : "Show more"}
        </Button>
      )}
      {caption && <div className="chat-caption">{caption}</div>}
      <div className="chat-you-actions">
        {time && <span className="chat-fine">{time}</span>}
        <IconButton
          label="Copy message"
          onClick={() => void copy("Message", item.text)}
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        </IconButton>
        <span className="sr-only" role="status">
          {copied && "Copied"}
          {error}
        </span>
      </div>
    </div>
  );
}

function Response({
  item,
  harness,
  readOnly,
  actions,
}: {
  item: ItemOf<"response">;
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

/** A Project, Document or Plan linked to the Chat, by its title. */
function useRecordName(): RecordName {
  const { links } = useContext(SentLinksContext);
  return useMemo(() => recordNamer(links), [links]);
}

/** One neutral icon per step kind; the verb carries the meaning. */
const STEP_ICONS: Record<Step["kind"], LucideIcon> = {
  read: Eye,
  search: Search,
  edit: Pencil,
  create: SquarePlus,
  delete: Trash2,
  run: Terminal,
  web: Globe,
  other: Wrench,
};

/** Whether a step's targets are files that can still be opened. */
const opensFiles = (step: Step) =>
  (step.kind === "read" && step.variant !== "list") ||
  step.kind === "edit" ||
  step.kind === "create";

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
  // Opened, a command shows exactly what ran.
  const command = step.kind === "run" ? step.command : undefined;
  const { folder } = useContext(ChatFilesContext);
  const [failure, setFailure] = useState("");
  const files = opensFiles(step);
  // A command says where it ran: its own folder, or the Chat's.
  const detail =
    command && !step.folder && folder
      ? [words.detail, `in ${folder}`].filter(Boolean).join(" · ")
      : words.detail;
  return (
    <div className="chat-steplist" id={command ? undefined : id}>
      {command ? (
        <OutputBox id={id} command={command} output={step.output} />
      ) : targets.length > 2 ? (
        <ul>
          {targets.map((target, index) => (
            <li key={index}>
              {files ? (
                <FileName
                  path={target.text}
                  shown={target.text}
                  onFailed={setFailure}
                />
              ) : (
                <code>{target.text}</code>
              )}
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
        step.output && (
          <pre className="chat-out">{plainOutput(step.output)}</pre>
        )
      )}
      {failure && (
        <p className="chat-fine" role="alert">
          {failure}
        </p>
      )}
      {detail && <p className="chat-fine">{detail}</p>}
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
  const words = stepWords(step, useRecordName());
  const running = live && step.state === "running";
  // MOTION-8: a step that finishes in view starts at its running verb's width,
  // then eases to its own, so the name after it neither jumps nor leaves a gap.
  const verb = useRef<HTMLSpanElement>(null);
  const [verbWidth, setVerbWidth] = useState<number>();
  const [eased, setEased] = useState(false);
  const verbText = words.parts[0]?.text;
  useLayoutEffect(() => {
    if (running && verb.current) {
      setVerbWidth(verb.current.offsetWidth);
      setEased(false);
    }
  }, [running, verbText]);
  useEffect(() => {
    if (running || verbWidth === undefined || eased) return;
    const frame = requestAnimationFrame(() => setEased(true));
    return () => cancelAnimationFrame(frame);
  }, [running, verbWidth, eased]);
  const now = useNow(running && Boolean(step.started_at));
  const started = step.started_at ? Date.parse(step.started_at) : NaN;
  const clock =
    running && now - started >= 1000 ? duration(now - started) : undefined;
  const [failure, setFailure] = useState("");
  const detail =
    (step.kind === "run" && Boolean(step.command)) ||
    Boolean(step.output) ||
    (step.targets?.length ?? 0) > 2 ||
    Boolean(words.detail || step.result || step.truncated);
  // A row that opens is a button already, so its names cannot be buttons too.
  const files = !detail && opensFiles(step) ? (step.targets ?? []) : [];
  const names = shownNames(files.map((target) => target.text));
  const Icon = STEP_ICONS[step.kind];
  const line = (
    <RowLine
      icon={
        running ? (
          <LoaderCircle size={12} className="chat-spin" />
        ) : (
          <Icon size={16} />
        )
      }
    >
      {words.parts.map((part, index) => {
        const file = part.code
          ? files.findIndex((target) => target.text === part.text)
          : -1;
        if (index === 0 && !part.code)
          return (
            <span
              key={index}
              ref={verb}
              className="chat-step-verb"
              style={
                verbWidth && !running
                  ? { minWidth: eased ? 0 : verbWidth }
                  : undefined
              }
            >
              {part.text}
            </span>
          );
        return (
          <Fragment key={index}>
            {index > 0 && part.text !== "," && " "}
            {file >= 0 ? (
              <FileName
                path={part.text}
                shown={names[file] ?? part.text}
                onFailed={setFailure}
              />
            ) : part.code ? (
              <code>{part.text}</code>
            ) : (
              part.text
            )}
          </Fragment>
        );
      })}
      {words.suffix ? (
        <>
          <span aria-hidden> · </span>
          <span
            data-outcome={words.suffix.outcome ? "" : undefined}
            className={words.suffix.diffstat ? "chat-file-counts" : undefined}
          >
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
  const row = detail ? (
    // A plain row, not a Button: the design draws the whole step line as the target.
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
      {failure && (
        <p className="chat-fine chat-step-alert" role="alert">
          {failure}
        </p>
      )}
      {open && <StepDetail id={id} step={step} harness={harness} />}
    </>
  );
}

/** A record the agent changed, as a step row: verb first, the reference in mono. */
function RecordStep({ change }: { change: RecordChange }) {
  const openDocument = useContext(DocumentNavigation);
  let icon: ReactNode;
  let words: ReactNode;
  switch (change.kind) {
    case "status":
      icon = <StatusIcon status={change.to} decorative />;
      words = (
        <>
          Moved <Reference>{change.reference}</Reference>
          {goneWords(change.gone)} to {change.to}
        </>
      );
      break;
    case "update":
      icon = <MessageSquareText size={16} />;
      words = (
        <>
          Posted an update on <Reference>{change.reference}</Reference>
          {goneWords(change.gone)}
        </>
      );
      break;
    case "document":
      icon = <FileText size={16} />;
      // The title is the link, without quotes.
      words = (
        <>
          Created the Document{" "}
          {openDocument && !change.gone ? (
            // Inline text, not a Button: it reads as a link inside the sentence.
            <button
              type="button"
              className="chat-record-link"
              onClick={() => openDocument(change.document_id)}
            >
              {change.title}
            </button>
          ) : (
            <>
              {change.title}
              {goneWords(change.gone)}
            </>
          )}
        </>
      );
      break;
  }
  return (
    <div className="chat-steps" data-anchor="">
      <RowLine icon={icon}>{words}</RowLine>
    </div>
  );
}

/** An answered question or an expired request, in regular weight with no fill. */
function Receipt({ item }: { item: ItemOf<"request"> }) {
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
function Note({ item }: { item: ItemOf<"marker"> }) {
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

/**
 * The harness's own warnings in a turn (an MCP server that did not start), as one
 * quiet line: "2 Codex warnings". They concern its setup, not the task, so they
 * open only when asked and fold with the turn.
 */
function Warnings({
  items,
  harness,
}: {
  items: ItemOf<"marker">[];
  harness: string;
}) {
  const [open, setOpen] = useState(false);
  const reading = useReading();
  const id = useId();
  const n = items.length;
  return (
    <>
      <button
        type="button"
        className="chat-steps chat-warnings"
        data-anchor=""
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={(event) => {
          reading.keep(event.currentTarget);
          setOpen(!open);
        }}
      >
        <RowLine icon={<Info size={16} />}>
          {n} {harness} {n === 1 ? "warning" : "warnings"}
        </RowLine>
        {open ? (
          <ChevronDown size={14} className="chat-chevron" aria-hidden />
        ) : (
          <ChevronRight size={14} className="chat-chevron" aria-hidden />
        )}
      </button>
      {open && (
        <ul id={id} className="chat-steplist chat-warning-list">
          {items.map((item) => (
            <li key={item.id}>{item.message}</li>
          ))}
        </ul>
      )}
    </>
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
        // Keyed by the item: the fold remounts the answer outside the rows, and
        // the reading position finds it again by this key.
        <div className="chat-turn-response" data-anchor={row.item.id}>
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
    case "warnings":
      return <Warnings items={row.items} harness={harness} />;
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
  // A turn seen running here fades its fold row in when it ends; history doesn't.
  const [endsHere] = useState(turn.live);
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
          // A plain row, not a Button: the turn's whole fold line is the target.
          <button
            ref={rowButton}
            id={rowId}
            type="button"
            className="chat-fold"
            data-fresh={endsHere ? "" : undefined}
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
        <div data-anchor={turn.final.id}>
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

function markerText(item: ItemOf<"marker">, harness: string) {
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
    case "warning":
      return item.message ?? "";
  }
}

function StopMarker({
  item,
  harness,
}: {
  item: ItemOf<"marker">;
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
      return item.reason === "warning" ? (
        <Warnings items={[item]} harness={harness} />
      ) : item.reason === "note" ? (
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
 * or reasoning row runs, so a turn has one spinner. `since` counts "Working for 1m 32s" from the turn's start, less the time it waited on the person; `fromShown`
 * counts from when the line appeared, for a phase the host gives no start time for.
 * The clock is not read out: one polite status says when a turn starts, waits and
 * ends.
 */
function WorkingLine({
  label,
  since,
  items = [],
  fromShown = false,
  spinner = true,
}: {
  label: string;
  since?: string;
  /** The transcript, whose requests' waits on the person are not working time. */
  items?: TranscriptItem[];
  fromShown?: boolean;
  spinner?: boolean;
}) {
  const [shown] = useState(() => Date.now());
  const now = useNow(Boolean(since) || fromShown);
  const worked = since ? workedFor(items, since, now) : NaN;
  return (
    <div className="chat-working">
      {spinner && <LoaderCircle size={12} className="chat-spin" aria-hidden />}
      <span>
        {since ? (
          Number.isNaN(worked) || worked < 1000 ? (
            `${label}…`
          ) : (
            <>
              {label} for <span aria-hidden="true">{duration(worked)}</span>
            </>
          )
        ) : (
          label
        )}
        {/* Like the working line, no clock before a second has passed: never "0s". */}
        {fromShown && now - shown >= 1000 && (
          <span aria-hidden="true"> · {duration(now - shown)}</span>
        )}
      </span>
    </div>
  );
}

/** How long no step must run before the working line takes the slot. */
const BETWEEN_STEPS_MS = 600;

/**
 * The working line, kept back while a step or reasoning row holds the spinner
 * and for a moment after: steps that follow each other closely keep the slot,
 * so the line does not flash between rows (MOTION-9). A turn whose first step
 * has not started shows the line at once.
 */
function BetweenSteps({
  running,
  children,
}: {
  running: boolean;
  children: ReactNode;
}) {
  const [shown, setShown] = useState(!running);
  // A step starting hides the line at once, in the same render.
  const [wasRunning, setWasRunning] = useState(running);
  if (running !== wasRunning) {
    setWasRunning(running);
    if (running) setShown(false);
  }
  useEffect(() => {
    if (running) return;
    const timer = setTimeout(() => setShown(true), BETWEEN_STEPS_MS);
    return () => clearTimeout(timer);
  }, [running]);
  return shown && !running ? children : <WorkingSlot />;
}

/** The working line's place while a turn runs and the line is not shown. */
function WorkingSlot() {
  return <div className="chat-working-slot" aria-hidden="true" />;
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
  const client = useChatClient();
  const chatId = chat.id;
  const folder = chat.folder.name;
  const missing = chat.folder.missing;
  const files = useMemo(
    () => ({
      folder,
      // With the folder missing there is nothing to open.
      ...(!missing && {
        open: (path: string) => client.openFile(chatId, path),
      }),
    }),
    [client, chatId, folder, missing],
  );
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
  const sentLinks = { links: chat.links, trashed: chat.trashed_links };
  const stepRuns = parts.some(
    (part) =>
      part.kind === "turn" &&
      part.turn.live &&
      part.turn.rows.some(
        (row) =>
          (row.kind === "step" && row.step.state === "running") ||
          (row.kind === "reasoning" && row.item.state === "running"),
      ),
  );
  const working = chat.activity === "working";
  const empty = items.length === 0 && !chat.catching_up && !isLive(chat);
  const asking = items.some(
    (item) => item.kind === "request" && item.state === "pending",
  );
  return (
    <ChatFilesContext.Provider value={files}>
      <SentLinksContext.Provider value={sentLinks}>
        <OpeningContext.Provider value={working && Boolean(chat.opening)}>
          <div className="chat-col" ref={contentRef}>
            {empty && !readOnly && (
              <p className="chat-empty">Say what you want done.</p>
            )}
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
                  <div
                    className="chat-part"
                    data-anchor=""
                    data-seen={part.item.id}
                  >
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
              // The dock already shows the request; the slot keeps its height.
              chat.has_composer && asking ? (
                <WorkingSlot />
              ) : (
                <WorkingLine label="Waiting for you" spinner={false} />
              )
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
            ) : // After an unconfirmed stop the open turn row and the notice say it.
            working &&
              !parts.some(
                (part) => part.kind === "turn" && part.turn.unconfirmed,
              ) ? (
              <BetweenSteps running={stepRuns}>
                {chat.doing ? (
                  <WorkingLine
                    label={chat.doing.label}
                    since={chat.doing.since}
                    items={items}
                  />
                ) : (
                  <WorkingLine label="Working…" />
                )}
              </BetweenSteps>
            ) : (
              // While a step row holds the spinner the line's place is kept,
              // so the end of the transcript does not bounce between rows.
              working && <WorkingSlot />
            )}
          </div>
        </OpeningContext.Provider>
      </SentLinksContext.Provider>
    </ChatFilesContext.Provider>
  );
}
