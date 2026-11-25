import { renderedLines } from "@/components/ui/rendered-lines";
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
import { RecordLink } from "@/components/ui/record-link";
import { StatusDot } from "@/components/ui/status-dot";
import { Tooltip } from "@/components/ui/tooltip";
import { CopyButton } from "@/components/ui/copy-button";
import { MarkdownDocument } from "@/features/markdown/MarkdownDocument";
import { DocumentNavigation } from "@/features/documents/navigation";
import { StatusIcon } from "@/features/tickets/StatusIcon";
import {
  useChatClient,
  type ChatState,
  type RecordChange,
  type Step,
  type TicketdCall,
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
  failureMarkerMatches,
  workedFor,
  isLive,
  lastOf,
  recordNamer,
  type RecordName,
  type TranscriptPart,
  type Stretch,
  type Turn,
  type TurnRow,
  type ViewStep,
  goneWords,
  sentence,
  turnClock,
  turnSpanText,
} from "@/features/chats/model";
import { FileName, PathCode } from "@/features/chats/FileName";
import {
  ChatFilesContext,
  SentLinksContext,
  scopeIsPath,
} from "@/features/chats/files";
import { sentParts } from "@/features/chats/composer-mentions";
import { inView, useKeptOpen } from "@/features/chats/use-kept-open";
import {
  steerCaption,
  steersAwaitingRead,
} from "@/features/chats/steer-caption";
import { TicketNavigation } from "@/features/tickets/navigation";
import { ProjectNavigation } from "@/features/documents/navigation";
import { ImageTiles } from "@/features/chats/ImageTiles";
import { OutputBox } from "@/features/chats/OutputBox";
import { ReceiptRow } from "@/features/chats/ReceiptRow";
import { Arrives } from "@/features/chats/arrivals";
import {
  ArrivalsContext,
  useArrivals,
  useChunkStarts,
} from "@/features/chats/use-arrivals";
import { Presence, Appear, Shimmer } from "@/components/ui/motion";
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
 * What a sent message asks of its Chat. `opening`: the session is opening, its
 * working line says "Starting…", so a message's own "Sending…" is not said too
 * (LIVE-6, one status row). `waiting`: steers the harness has taken and not
 * yet acted on, which say when they will be read.
 */
const UserMessageContext = createContext<{
  opening: boolean;
  waiting: ReadonlySet<string>;
  harness: string;
}>({ opening: false, waiting: new Set(), harness: "" });

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
        {ticket ? <RecordLink gone reference={text} /> : text}
        {goneWords("trashed")}
      </>
    );
  const open = () =>
    record.kind === "ticket"
      ? openTicket?.(record.reference)
      : record.kind === "document"
        ? openDocument?.(record.id)
        : openProject?.(record.id);
  return ticket ? (
    <RecordLink reference={text} onClick={open} />
  ) : (
    <RecordLink onClick={open}>{text}</RecordLink>
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

/**
 * Your message, exactly as sent, on the right. Past four lines it folds behind
 * Show more. Copy shows beside it on hover or focus; the turn's time is on its
 * work line.
 */
function UserMessage({ item }: { item: ItemOf<"user"> }) {
  const { opening, waiting, harness } = useContext(UserMessageContext);
  const caption =
    opening && item.delivery === "sending"
      ? ""
      : waiting.has(item.id)
        ? steerCaption(harness)
        : DELIVERY_CAPTION[item.delivery];
  const text = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [more, setMore] = useState(false);
  // Measured again whenever the message's width changes: a pane narrowed after
  // the message was shown clamps it, and then it needs Show more. Decided by
  // rendered lines, not pixels: a mention chip overflows its line by 2px and
  // made one-line messages offer Show more (CH-31).
  useLayoutEffect(() => {
    const box = text.current;
    if (!box || more) return;
    const measure = () => setLong(renderedLines(box) > 4);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [item.text, more]);
  return (
    <div className="chat-you-part">
      <Arrives id={item.id} className="flex flex-col items-end">
        {item.images && item.images.length > 0 && (
          <ImageTiles images={item.images} />
        )}
        <div className="chat-you-box">
          <div className="chat-you">
            <div ref={text} data-clamped={more ? undefined : ""}>
              <span className="sr-only">You: </span>
              <SentText text={item.text} />
            </div>
          </div>
          <div className="chat-you-actions">
            {/* One copy confirmation everywhere: the shared CopyButton (CH-51). */}
            <CopyButton text={item.text} label="Copy message" />
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
      </Arrives>
    </div>
  );
}

/** A response's text. Its actions belong to the turn's end (ReplyActions). */
const Response = memo(function Response({
  item,
  harness,
}: {
  item: ItemOf<"response">;
  harness: string;
}) {
  // Streamed text fades in chunk by chunk as it arrives; no typewriter.
  const chunkStarts = useChunkStarts(item.text, item.state === "streaming");
  return (
    <div className="chat-turn">
      <Arrives id={item.id} className="flex flex-col">
        <div className="chat-ai">
          <span className="sr-only">{harness}: </span>
          <MarkdownDocument source={item.text} chunkStarts={chunkStarts} />
        </div>
        {item.state === "partial" && (
          <p className="chat-fine">
            Incomplete. ticketd closed before the rest of this response was
            saved.
          </p>
        )}
      </Arrives>
    </div>
  );
});

/**
 * Copy and Save as Document for a turn's final response. They sit in the 40px gap
 * after the turn, shown on hover or focus without taking space (coarse pointers
 * keep them in a row). A progress note has none.
 */
function ReplyActions({
  item,
  readOnly,
  actions,
}: {
  item: ItemOf<"response">;
  readOnly: boolean;
  actions: TranscriptActions;
}) {
  if (item.state !== "complete") return null;
  return (
    <div className="chat-turn-actions">
      <CopyButton text={item.text} label="Copy response" />
      {!readOnly && (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => actions.saveAsDocument(item)}
        >
          <FilePlus2 aria-hidden /> Save as Document
        </Button>
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

/**
 * A command that only calls ticketd reads as what it does, so its icon is
 * its first verb's, not the terminal's: "Read T-12" takes the eye (CH-29).
 */
const TICKETD_ICONS: Record<TicketdCall["verb"], LucideIcon> = {
  read: Eye,
  list: Eye,
  search: Search,
  create: SquarePlus,
  add: SquarePlus,
  change: Pencil,
  set: Pencil,
  move: Pencil,
  restore: Pencil,
  tag: Pencil,
  untag: Pencil,
  post: MessageSquareText,
  run: Terminal,
};

/** Whether a step's targets are files that can still be opened. */
const opensFiles = (step: ViewStep) =>
  (step.kind === "read" && step.variant !== "list") ||
  step.kind === "edit" ||
  step.kind === "create";

/** An opened step shows its command or targets alongside any tool output. */
function StepDetail({
  id,
  step,
  harness,
}: {
  id: string;
  step: ViewStep;
  harness: string;
}) {
  const targets = step.targets ?? [];
  const words = stepWords(step);
  // Opened, a command shows exactly what ran.
  const command = step.kind === "run" ? step.command : undefined;
  const { folder, output: readOutput } = useContext(ChatFilesContext);
  const [failure, setFailure] = useState("");
  const files = opensFiles(step) || (step.explored?.files.length ?? 0) > 0;
  // The targets of these are folders and files: the folder muted, the name in ink.
  const pathKind =
    (step.kind === "read" && step.variant === "list") || step.kind === "delete";
  // A step carries only its output's end; opened, it reads the whole of it.
  const toolId = step.full_output?.tool_id;
  const [whole, setWhole] = useState<{ toolId: string; text: string }>();
  useEffect(() => {
    if (!toolId || !readOutput) return;
    let current = true;
    readOutput(toolId).then(
      (text) => current && text !== null && setWhole({ toolId, text }),
      // The end it has stays shown.
      () => {},
    );
    return () => {
      current = false;
    };
  }, [toolId, readOutput]);
  const output = whole && whole.toolId === toolId ? whole.text : step.output;
  // A command says where it ran: its own folder, or the Chat's.
  const detail =
    command && !step.folder && folder
      ? [words.detail, `in ${folder}`].filter(Boolean).join(" · ")
      : words.detail;
  return (
    <div className="chat-steplist" id={command ? undefined : id}>
      {command ? (
        // Remounted when the whole output arrives, so it opens at its last line again.
        <OutputBox
          key={output === step.output ? "end" : "whole"}
          id={id}
          command={command}
          output={output}
        />
      ) : (
        <>
          {step.explored ? (
            <ul>
              {step.explored.files.map((target, index) => (
                <li key={`file-${index}`}>
                  {files ? (
                    <FileName path={target.text} onFailed={setFailure} />
                  ) : (
                    <PathCode path={target.text} />
                  )}
                  {target.lines && <small>{targetLines(target)}</small>}
                </li>
              ))}
              {step.explored.searches.map((target, index) => (
                <li key={`search-${index}`}>
                  Searched for <code>{target.text}</code>
                  {target.scope && (
                    <>
                      {" "}
                      in{" "}
                      {scopeIsPath(target.scope) ? (
                        <PathCode path={target.scope} />
                      ) : (
                        <code>{target.scope}</code>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            (targets.length > 2 ||
              (step.omitted_files && targets.length > 0)) && (
              <ul>
                {targets.map((target, index) => (
                  <li key={index}>
                    {files ? (
                      <FileName path={target.text} onFailed={setFailure} />
                    ) : pathKind ? (
                      <PathCode path={target.text} />
                    ) : (
                      <code>{target.text}</code>
                    )}
                    {target.scope && (
                      <>
                        {" "}
                        in{" "}
                        {scopeIsPath(target.scope) ? (
                          <PathCode path={target.scope} />
                        ) : (
                          <code>{target.scope}</code>
                        )}
                      </>
                    )}
                    {target.lines && <small>{targetLines(target)}</small>}
                  </li>
                ))}
              </ul>
            )
          )}
          {output && <pre className="chat-out">{plainOutput(output)}</pre>}
        </>
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
  line,
  children,
}: {
  icon?: ReactNode;
  /** A command with no description: one muted line, cut with an ellipsis. */
  line?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <span className="chat-row-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="chat-step-words" data-line={line ? "" : undefined}>
        {children}
      </span>
    </>
  );
}

/**
 * One step: `[icon] Verb target · suffix`. While it runs, and the view is live
 * rather than replaying history, the spinner takes the icon's slot and a clock
 * counts from the host's start time. `decision` is the answered approval the step
 * waited on, shown as its tooltip and description.
 */
export const StepRow = memo(function StepRow({
  step,
  harness,
  decision,
  live,
}: {
  step: ViewStep;
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
    Boolean(step.explored) ||
    (step.kind === "run" && Boolean(step.command)) ||
    Boolean(step.output) ||
    (step.targets?.length ?? 0) > 2 ||
    Boolean(step.omitted_files && step.targets?.length) ||
    Boolean(words.detail || step.result || step.truncated);
  // A row that opens is a button already, so its names cannot be buttons too.
  const files = !detail && opensFiles(step) ? (step.targets ?? []) : [];
  const call = step.kind === "run" ? step.ticketd?.[0] : undefined;
  const Icon = call
    ? TICKETD_ICONS[call.verb]
    : STEP_ICONS[step.explored ? "read" : step.kind];
  const line = (
    <RowLine
      line={words.parts.some((part) => part.command)}
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
              {/* A soft light passes over the words of the step that runs. */}
              {running ? <Shimmer>{part.text}</Shimmer> : part.text}
            </span>
          );
        return (
          <Fragment key={index}>
            {index > 0 && part.text !== "," && " "}
            {file >= 0 ? (
              <FileName path={part.text} onFailed={setFailure} />
            ) : part.path ? (
              <PathCode path={part.text} />
            ) : part.command ? (
              <code className="chat-step-command">{part.text}</code>
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
      <Tooltip content={decision} side="right">
        {row}
      </Tooltip>
      {failure && (
        <p className="chat-fine chat-step-alert" role="alert">
          {failure}
        </p>
      )}
      {open && <StepDetail id={id} step={step} harness={harness} />}
    </>
  );
});

/** A record the agent changed, as a step row: verb first, the reference in mono. */
function RecordStep({ change }: { change: RecordChange }) {
  const openDocument = useContext(DocumentNavigation);
  const openTicket = useContext(TicketNavigation);
  // A reference that opens is a RecordLink; one that is gone is plain (CH-28).
  const ticket = (reference: string) =>
    change.gone || !openTicket ? (
      <RecordLink gone reference={reference} />
    ) : (
      <RecordLink reference={reference} onClick={() => openTicket(reference)} />
    );
  let icon: ReactNode;
  let words: ReactNode;
  switch (change.kind) {
    case "status":
      icon = <StatusIcon status={change.to} decorative />;
      words = (
        <>
          Moved {ticket(change.reference)}
          {goneWords(change.gone)} to {change.to}
        </>
      );
      break;
    case "update":
      icon = <MessageSquareText size={16} />;
      words = (
        <>
          Posted an update on {ticket(change.reference)}
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
            <RecordLink onClick={() => openDocument(change.document_id)}>
              {change.title}
            </RecordLink>
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

/**
 * "Answered · Fail open", or "Expired · `npm test`": what expired is a
 * command or path, so it is set in mono as step targets are (CH-30).
 */
function ReceiptWords({ item }: { item: ItemOf<"request"> }) {
  if (item.state !== "expired" || item.request === "question")
    return receiptLine(item);
  return (
    <>
      Expired · <code className="chat-mono">{item.subject ?? item.title}</code>
    </>
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
        <ReceiptWords item={item} />
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
        <Arrives id={row.key}>
          <StepRow
            step={row.step}
            harness={harness}
            decision={row.decision}
            live={live}
          />
        </Arrives>
      );
    case "progress":
      return (
        // Keyed by the item: the fold remounts the answer outside the rows, and
        // the reading position finds it again by this key.
        <div className="chat-turn-response" data-anchor={row.item.id}>
          <Response item={row.item} harness={harness} />
        </div>
      );
    case "record":
      return <RecordStep change={row.change} />;
    case "receipt":
      return (
        <Arrives id={row.key}>
          <Receipt item={row.item} />
        </Arrives>
      );
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

/**
 * A stretch of a turn's work, between two progress notes. While it is in progress
 * its steps show as they come, and when it finishes in view they stay put until it
 * has left the view (the turn's own rule), so nothing above the newest line moves.
 * Then it folds to one muted row, which opens to its steps. A stretch that was
 * already done when it first showed starts folded; the person's own toggle wins.
 */
function StretchView({
  stretch,
  stretchKey,
  harness,
  readOnly,
  actions,
  live,
  open: always,
}: {
  stretch: Stretch;
  stretchKey: string;
  harness: string;
  readOnly: boolean;
  actions: TranscriptActions;
  live: boolean;
  /** Its steps show with no row of their own: the turn is its one stretch, or a stop was not confirmed. */
  open: boolean;
}) {
  const [toggled, setToggled] = useState(() => toggles.get(stretchKey));
  const reading = useReading();
  const part = useRef<HTMLDivElement>(null);
  const rowButton = useRef<HTMLButtonElement>(null);
  const bodyId = useId();
  const rowId = useId();
  const kept = useKeptOpen(!stretch.ongoing, part, inView);
  // Shown bare (steps only) while it is the work going on, or kept after it ends in
  // view, so the row does not appear above steps someone is reading.
  const bare = always || (toggled === undefined && kept);
  const open = bare || toggled === true;
  const toggle = () => {
    toggles.set(stretchKey, !open);
    setToggled(!open);
    // The row stays where the reader clicked it.
    if (rowButton.current) reading.keep(rowButton.current);
    // Collapsing with focus inside leaves focus on the row.
    if (open) rowButton.current?.focus();
  };
  // A stretch of one merged Explored row opens to its files, not to a row that says
  // the same words again.
  const only = stretch.rows.length === 1 ? stretch.rows[0] : undefined;
  const explored =
    only?.kind === "step" && only.step.explored ? only.step : undefined;
  const rows = stretch.rows.map((row) => (
    <Row
      key={row.key}
      row={row}
      harness={harness}
      readOnly={readOnly}
      actions={actions}
      live={live}
    />
  ));
  return (
    <div ref={part} className="chat-stretch">
      {!bare && (
        <button
          ref={rowButton}
          id={rowId}
          type="button"
          className="chat-fold chat-stretch-row"
          data-anchor=""
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          onClick={toggle}
        >
          <span>{stretch.label}</span>
          {open ? (
            <ChevronDown size={14} aria-hidden />
          ) : (
            <ChevronRight size={14} aria-hidden />
          )}
        </button>
      )}
      {open &&
        (bare ? (
          <div className="chat-turn-rows">{rows}</div>
        ) : (
          <div
            id={bodyId}
            className="chat-turn-rows chat-stretch-steps"
            role="group"
            aria-labelledby={rowId}
          >
            {explored ? (
              <StepDetail
                id={`${bodyId}-files`}
                step={explored}
                harness={harness}
              />
            ) : (
              rows
            )}
          </div>
        ))}
    </div>
  );
}

/** Fold toggles the person made, by Chat and turn; they win for the session. */
const toggles = new Map<string, boolean>();

/**
 * A turn. While it runs its rows show as they come. Once it ends they fold under
 * one muted row, and the final response and end marker stay outside. A turn the
 * person is reading in, or that holds focus, folds once it is out of view; a stop
 * that was not confirmed stays open.
 */
const TurnView = memo(function TurnView({
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
  // until it leaves the view.
  const kept = useKeptOpen(
    !turn.live,
    part,
    (element, scroller) => !reading.follows() && inView(element, scroller),
  );
  // A turn seen running here fades its fold row in when it ends; history doesn't.
  const [endsHere] = useState(turn.live);
  const folds = turn.rows.some((row) => row.kept !== true);
  const showRow = !turn.live && folds;
  const open = !showRow || (toggled ?? (turn.unconfirmed || kept));
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
  const row = (each: TurnRow) => (
    <Row
      key={each.key}
      row={each}
      harness={harness}
      readOnly={readOnly}
      actions={actions}
      live={rowLive}
    />
  );
  const blocks = turn.blocks.map((block) =>
    block.kind === "stretch" ? (
      <StretchView
        key={block.key}
        stretch={block}
        stretchKey={`${key}:${block.key}`}
        harness={harness}
        readOnly={readOnly}
        actions={actions}
        live={rowLive}
        open={turn.unconfirmed}
      />
    ) : (
      row(block)
    ),
  );
  // A turn that shows nothing of its work (only its answer) has no work part.
  const work = showRow || turn.rows.length > 0;
  return (
    // One unit: its parts sit 12px apart, and 40px separates it from what
    // follows, where its reply actions show.
    <div className="chat-turn-unit" data-seen={turn.ids.at(-1)}>
      {work && (
        <div ref={part} className="chat-turnpart" data-anchor="">
          {showRow && (
            <div className="chat-foldline">
              {/* A plain row, not a Button: the turn's whole fold line is the target. */}
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
              <TurnTime turn={turn} />
            </div>
          )}
          {open ? (
            <div
              id={showRow ? bodyId : undefined}
              className="chat-turn-rows"
              data-folded={showRow ? "" : undefined}
              role={showRow ? "group" : undefined}
              aria-labelledby={showRow ? rowId : undefined}
            >
              {blocks}
            </div>
          ) : (
            // Collapsed, receipts and notes sit under the turn row in order.
            turn.rows.some((row) => row.kept === true) && (
              <div className="chat-turn-rows">
                {turn.rows.filter((each) => each.kept === true).map(row)}
              </div>
            )
          )}
        </div>
      )}
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
          <Response item={turn.final} harness={harness} />
        </div>
      )}
      {/* Below the response, in order: the stop marker, then #367's changed
          files row, then #364's records row. */}
      {turn.marker && (
        <div data-anchor="">
          <StopMarker
            item={turn.marker}
            harness={harness}
            detailShown={failureMarkerMatches(turn.marker, turn.final?.text)}
          />
        </div>
      )}
      {turn.files && (
        <div className="chat-changed" data-anchor="">
          <FilesSummary
            item={turn.files}
            commandEdits={turn.commandEdits ?? false}
            onOpen={actions.openFile}
          />
        </div>
      )}
      {!turn.live && changes.length > 0 && (
        <div className="chat-changed" data-anchor="">
          {/* Never folded; "N more" opens the fold, where each is a step row. */}
          <ReceiptRow
            changes={changes}
            onMore={() => {
              if (!open) toggle();
            }}
          />
        </div>
      )}
      {turn.final && (
        <ReplyActions item={turn.final} readOnly={readOnly} actions={actions} />
      )}
    </div>
  );
});

/**
 * The turn's one time, on the right of its work line: its start ("14:03",
 * "Yesterday 18:40", "Nov 24"), with the exact start and end in its tooltip.
 */
function TurnTime({ turn }: { turn: Turn }) {
  if (!turn.started) return null;
  const clock = turnClock(turn.started);
  if (!clock) return null;
  return (
    <Tooltip content={turnSpanText(turn.started, turn.ended)}>
      <time className="chat-turn-time" dateTime={turn.started}>
        {clock}
      </time>
    </Tooltip>
  );
}

function markerText(
  item: ItemOf<"marker">,
  harness: string,
  detailShown: boolean,
) {
  const detail = item.message ? ` ${sentence(item.message)}` : "";
  switch (item.reason) {
    case "stopped":
      return `You stopped this turn. Edits already made are kept.${detail}`;
    case "quit":
      return `Stopped when ticketd quit. Edits already made are kept.${detail}`;
    case "turned_off":
      return `Stopped when Chat was turned off. Edits already made are kept.${detail}`;
    case "restore":
      return `Stopped when a backup was restored. Edits already made are kept.${detail}`;
    case "taken_over":
      return `You took this run over. Edits already made are kept.${detail}`;
    case "time_limit":
      return `Stopped at the run's time limit. Edits already made are kept.${detail}`;
    case "run_ended":
      return `Stopped when its run step ended. Edits already made are kept.${detail}`;
    case "trashed":
      return `Stopped when the Chat was moved to the trash. Edits already made are kept.${detail}`;
    case "explicit_resume":
      return `Stopped when the Chat was resumed. Edits already made are kept.${detail}`;
    case "storage_failed":
      return `Stopped when Chat storage failed. Edits already made are kept.${detail}`;
    case "stop_unconfirmed":
      return `ticketd asked ${harness} to stop but it didn't confirm. It may still be running.${detail}`;
    case "failed": {
      const reason = detailShown ? "" : detail || ` ${harness} gave no reason.`;
      return `This turn failed.${reason} What it finished before that is kept.`;
    }
    case "note":
    case "warning":
      return item.message ?? "";
  }
}

function StopMarker({
  item,
  harness,
  detailShown = false,
}: {
  item: ItemOf<"marker">;
  harness: string;
  detailShown?: boolean;
}) {
  return (
    <p className="chat-line">
      {/* Filled, the stop sign does not read as an empty checkbox. */}
      <Square size={12} fill="currentColor" aria-hidden />
      <span>{markerText(item, harness, detailShown)}</span>
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
      // Outside any turn the response is its own final one.
      return (
        <div className="chat-turn-unit">
          <Response item={item} harness={harness} />
          <ReplyActions item={item} readOnly={readOnly} actions={actions} />
        </div>
      );
    case "session": {
      const label =
        item.history === "none"
          ? "Fresh session · no earlier messages imported"
          : `Fresh session · started with ${SESSION_HISTORY[item.history](item.count)}`;
      return (
        <div className="chat-divider" role="separator" aria-label={label}>
          {label}
        </div>
      );
    }
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
      <Words shimmer={spinner}>
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
      </Words>
    </div>
  );
}

/** The working line's words; they shimmer while the line has its spinner. */
function Words({
  shimmer,
  children,
}: {
  shimmer: boolean;
  children: ReactNode;
}) {
  return shimmer ? <Shimmer>{children}</Shimmer> : <span>{children}</span>;
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
      <Presence initial={false}>
        {shown && (
          <Appear key="jump">
            <Button
              variant="outline"
              size="sm"
              // A click from the keyboard has no pointer position.
              onClick={(event) => onJump(event.detail === 0)}
            >
              <ArrowDown aria-hidden /> Jump to latest
            </Button>
          </Appear>
        )}
      </Presence>
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
  parts,
  actions,
  picked,
  onPick,
  newFrom,
  markerRef,
  contentRef,
}: {
  chat: ChatState;
  items: TranscriptItem[];
  parts: TranscriptPart[];
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
      output: (toolId: string) => client.stepOutput(chatId, toolId),
    }),
    [client, chatId, folder, missing],
  );
  // Every chat change brings new arrays; the value moves only when the links
  // read differently, so the rows reading them are not drawn again.
  const linksKey = JSON.stringify({
    links: chat.links,
    trashed: chat.trashed_links,
  });
  const sentLinks = useMemo(
    () => JSON.parse(linksKey) as { links: LinkedRecord[]; trashed: string[] },
    [linksKey],
  );
  const arrivals = useArrivals(
    chat.id,
    parts.flatMap((part) =>
      part.kind === "turn"
        ? [
            ...part.turn.rows.map((row) => row.key),
            ...(part.turn.final ? [part.turn.final.id] : []),
          ]
        : [part.item.id],
    ),
    chat.catching_up,
  );
  const working = chat.activity === "working";
  const opening = working && Boolean(chat.opening);
  const waiting = useMemo(
    () => steersAwaitingRead(items, working),
    [items, working],
  );
  const userMessages = useMemo(
    () => ({ opening, waiting, harness }),
    [opening, waiting, harness],
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
  const live = !chat.catching_up;
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
  // Words are streaming in now: the newest thing in the Chat is a response still arriving.
  const newest = lastOf(items, (item) => item.kind !== "turn");
  const writing = newest?.kind === "response" && newest.state === "streaming";
  const empty = items.length === 0 && !chat.catching_up && !isLive(chat);
  const asking = items.some(
    (item) => item.kind === "request" && item.state === "pending",
  );
  return (
    <ArrivalsContext value={arrivals}>
      <ChatFilesContext.Provider value={files}>
        <SentLinksContext.Provider value={sentLinks}>
          <UserMessageContext.Provider value={userMessages}>
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
                      data-kind={part.item.kind}
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
                  <div
                    className="chat-skel chat-skel-long"
                    aria-hidden="true"
                  />
                  <div
                    className="chat-skel chat-skel-short"
                    aria-hidden="true"
                  />
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
                  {writing ? (
                    // Words are arriving: the one live line says so, with its own clock.
                    <WorkingLine key="writing" label="Writing" fromShown />
                  ) : chat.doing ? (
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
          </UserMessageContext.Provider>
        </SentLinksContext.Provider>
      </ChatFilesContext.Provider>
    </ArrivalsContext>
  );
}
