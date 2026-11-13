import { useEffect, useId, useState, type ReactNode } from "react";
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  Copy,
  File,
  FileDiff,
  FilePlus2,
  ListTodo,
  LoaderCircle,
} from "lucide-react";
import "@/features/chats/turn-reports.css";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { StatusDot } from "@/components/ui/status-dot";
import { useCopy } from "@/components/ui/use-copy";
import { MarkdownDocument } from "@/features/markdown/MarkdownDocument";
import type {
  ChangedFile,
  ContextUsage,
  PlanStep,
  ItemOf,
} from "@/features/chats/client";
import { duration } from "@/features/chats/model";
import {
  clockTime,
  contextWords,
  currentStep,
  fileCounts,
  fileKind,
  fileLabel,
  filesSummary,
  shortenedPath,
  planCount,
  reasoningShown,
  reasoningWords,
  tokens,
} from "@/features/chats/reports";

/**
 * The views of what a harness reported beyond text and tools (#367): a turn's
 * reasoning, its plan and changed files, and the session's context window.
 * Each draws only what was reported; nothing is drawn for what was not.
 */

/** Its chevron shows on hover, focus or while open, as on every row. */
function Chevron({ open }: { open: boolean }) {
  return open ? (
    <ChevronDown size={14} aria-hidden className="chat-chevron" />
  ) : (
    <ChevronRight size={14} aria-hidden className="chat-chevron" />
  );
}

/** Seconds since `since`, ticking while shown; the clock is not read out. */
function useNow(running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  return now;
}

export function ReasoningRow({ item }: { item: ItemOf<"reasoning"> }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const running = item.state === "running";
  const now = useNow(running);
  if (!reasoningShown(item)) return null;
  const words = reasoningWords(item);
  const since =
    running && item.started_at != null && now - item.started_at >= 1000
      ? duration(now - item.started_at)
      : null;
  const line = (
    <>
      <span className="chat-row-icon" aria-hidden="true">
        {running ? (
          <LoaderCircle size={12} className="chat-spin" />
        ) : (
          <Brain size={16} />
        )}
      </span>
      <span className="chat-step-words">
        {words.text}
        {since && <span aria-hidden="true"> · {since}</span>}
        {words.outcome && (
          <>
            <span aria-hidden> · </span>
            <span data-outcome="">{words.outcome}</span>
          </>
        )}
      </span>
    </>
  );
  if (!item.text)
    return <div className="chat-steps chat-report-row">{line}</div>;
  return (
    <>
      {/* A plain row, not a Button: the design draws the whole step line as the target. */}
      <button
        type="button"
        className="chat-steps chat-report-row"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={words.label}
        onClick={() => setOpen(!open)}
      >
        {line}
        <Chevron open={open} />
      </button>
      {open && (
        <div className="chat-reasoning" id={id}>
          <MarkdownDocument source={item.text} />
        </div>
      )}
    </>
  );
}

function StepGlyph({
  step,
  open,
}: {
  step: PlanStep;
  open: "Not finished" | "Not confirmed" | "In progress";
}) {
  return step.status === "completed" ? (
    <CircleCheck size={16} role="img" aria-label="Done" />
  ) : (
    <Circle size={16} role="img" aria-label={open} />
  );
}

function PlanSteps({
  steps,
  open,
}: {
  steps: PlanStep[];
  /** What a step that is not done reads as. */
  open?: "Not finished" | "Not confirmed";
}) {
  return (
    <ul className="chat-plan-steps">
      {steps.map((step, index) => (
        <li
          key={index}
          data-now={step.status === "in_progress" && !open ? "" : undefined}
        >
          <StepGlyph
            step={step}
            open={
              open ??
              (step.status === "in_progress" ? "In progress" : "Not finished")
            }
          />
          <span>
            {step.text}
            {open && step.status !== "completed" && (
              <>
                <span aria-hidden> · </span>
                <span data-outcome="">{open}</span>
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A turn's plan once the turn has ended. A finished plan is one row in the
 * turn; one left unfinished is a card, and can be saved as a Document.
 */
export function PlanCard({
  item,
  readOnly,
  onSave,
}: {
  item: ItemOf<"plan">;
  readOnly: boolean;
  onSave: (plan: ItemOf<"plan">) => void;
}) {
  const count = planCount(item.steps);
  if (item.state === "running" || count.total === 0) return null;
  if (item.state === "ended" && count.done === count.total)
    return (
      <div className="chat-steps chat-report-row">
        <span className="chat-row-icon" aria-hidden="true">
          <ListTodo size={16} />
        </span>
        <span className="chat-step-words">Plan · {count.text}</span>
      </div>
    );
  const open = item.state === "unconfirmed" ? "Not confirmed" : "Not finished";
  return (
    <section className="chat-plan" aria-label={`Plan, ${count.text}`}>
      <div className="chat-plan-head">
        <span className="chat-plan-title">Plan · {count.text}</span>
        {!readOnly && (
          // Shown on hover or focus; an icon in a narrow pane.
          <span className="chat-plan-save">
            <span className="chat-plan-save-wide">
              <Button variant="ghost" size="xs" onClick={() => onSave(item)}>
                <FilePlus2 aria-hidden /> Save as Document
              </Button>
            </span>
            <span className="chat-plan-save-narrow">
              <IconButton label="Save as Document" onClick={() => onSave(item)}>
                <FilePlus2 aria-hidden />
              </IconButton>
            </span>
          </span>
        )}
      </div>
      {item.explanation && <p className="chat-plan-note">{item.explanation}</p>}
      <PlanSteps steps={item.steps} open={open} />
    </section>
  );
}

/**
 * The plan's only home while its turn runs: one line in the activity dock,
 * opening the steps. It never takes focus from the message box.
 */
export function PlanPill({ item }: { item: ItemOf<"plan"> }) {
  const [open, setOpen] = useState(false);
  const count = planCount(item.steps);
  const now = currentStep(item.steps);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* A full-width row under the response, not a Button variant (DESIGN: plan pill). */}
        <button
          type="button"
          className="chat-plan-pill"
          aria-expanded={open}
          onMouseDown={(event) => event.preventDefault()}
        >
          <ListTodo size={16} aria-hidden />
          <span className="chat-plan-pill-count" aria-live="polite">
            {count.text}
          </span>
          {now && <span className="chat-plan-pill-now">· {now}</span>}
          <Chevron open={open} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={`Plan, ${count.text}`}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {item.explanation && (
          <p className="chat-plan-note">{item.explanation}</p>
        )}
        <PlanSteps steps={item.steps} />
      </PopoverContent>
    </Popover>
  );
}

function FileRow({
  file,
  onOpen,
}: {
  file: ChangedFile;
  onOpen: (path: string) => Promise<void>;
}) {
  const [failure, setFailure] = useState("");
  const { copied, copy } = useCopy();
  const kind = file.confirmed ? fileKind(file) : null;
  const words = (
    <>
      <File size={16} aria-hidden />
      <span className="chat-file-path">{shortenedPath(file.path)}</span>
      {kind && (
        <span
          className="chat-file-kind"
          {...(file.from && { title: `Renamed from ${file.from}` })}
        >
          {kind}
        </span>
      )}
      {!file.confirmed && (
        <span className="chat-file-kind" data-outcome="">
          Not confirmed
        </span>
      )}
      <span className="chat-file-counts">{fileCounts(file)}</span>
    </>
  );
  return (
    <li>
      <div className="chat-file">
        {file.kind === "deleted" ? (
          <div className="chat-file-main">{words}</div>
        ) : (
          // A plain row, not a Button: the whole file row is the target.
          <button
            type="button"
            className="chat-file-main"
            aria-label={fileLabel(file)}
            title={file.path}
            onClick={() =>
              void onOpen(file.open_path).then(
                () => setFailure(""),
                (reason: unknown) =>
                  setFailure(
                    reason instanceof Error ? reason.message : String(reason),
                  ),
              )
            }
          >
            {words}
          </button>
        )}
        <span className="chat-file-copy">
          <IconButton
            label={copied ? "Copied" : "Copy path"}
            onClick={() => void copy("Path", file.path)}
          >
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          </IconButton>
        </span>
      </div>
      {failure && <p className="chat-file-error">{failure}</p>}
    </li>
  );
}

const FIRST_FILES = 10;

/** The files a finished turn changed, below its response. */
export function FilesSummary({
  item,
  commandEdits,
  onOpen,
}: {
  item: ItemOf<"files">;
  /** The turn also ran commands that edited files this list cannot name. */
  commandEdits: boolean;
  onOpen: (path: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const id = useId();
  if (item.state === "running" || item.files.length === 0) return null;
  const summary = filesSummary(item.files);
  const shown = all ? item.files : item.files.slice(0, FIRST_FILES);
  const more = item.files.length - shown.length;
  return (
    <div className="chat-files">
      {/* A plain row, not a Button: the design draws the whole step line as the target. */}
      <button
        type="button"
        className="chat-steps chat-report-row"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        <span className="chat-row-icon" aria-hidden="true">
          <FileDiff size={16} />
        </span>
        <span className="chat-step-words">
          {summary.text}
          {summary.counts && (
            <>
              <span aria-hidden> · </span>
              <span className="chat-file-counts">{summary.counts}</span>
            </>
          )}
          {summary.unconfirmed && <> · {summary.unconfirmed}</>}
        </span>
        <Chevron open={open} />
      </button>
      {open && (
        <div id={id}>
          <ul className="chat-file-list" aria-label="Changed files">
            {shown.map((file) => (
              <FileRow key={file.open_path} file={file} onOpen={onOpen} />
            ))}
          </ul>
          {more > 0 && (
            <Button variant="ghost" size="xs" onClick={() => setAll(true)}>
              Show {more} more
            </Button>
          )}
          {commandEdits && (
            <p className="chat-file-error">Command edits not listed</p>
          )}
        </div>
      )}
    </div>
  );
}

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * How full the session's context window is, as the harness last said: a ring
 * before Stop, opening the details. From 90% it says so in words.
 */
export function ContextRing({
  context,
  turnStartedAt,
}: {
  context: ContextUsage;
  /** When the turn the person is looking at began; an older report says when it is from. */
  turnStartedAt?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const words = contextWords(context);
  const started = turnStartedAt ? new Date(turnStartedAt).getTime() : NaN;
  const stale = !Number.isNaN(started) && context.at < started;
  let full: ReactNode = null;
  if (words.full)
    full = (
      <>
        <StatusDot tone="attention" />
        <span className="chat-ring-full">{words.percent}% full</span>
      </>
    );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size={words.full ? "xs" : "icon-sm"}
          data-full={words.full ? "" : undefined}
          aria-label={words.label}
          onMouseDown={(event) => event.preventDefault()}
        >
          <svg
            className="chat-ring"
            viewBox="0 0 16 16"
            width={16}
            height={16}
            aria-hidden="true"
          >
            <circle className="chat-ring-track" cx="8" cy="8" r={RADIUS} />
            <circle
              className="chat-ring-arc"
              cx="8"
              cy="8"
              r={RADIUS}
              strokeDasharray={`${(CIRCUMFERENCE * words.percent) / 100} ${CIRCUMFERENCE}`}
            />
          </svg>
          {full}
        </Button>
      </PopoverTrigger>
      {/* Said once when the window passes 90%. */}
      <span className="sr-only" role="status">
        {words.full ? `Context window ${words.percent}% full` : ""}
      </span>
      <PopoverContent
        align="end"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <p className="chat-ring-head">{words.headline}</p>
        {context.categories.length > 0 && (
          <ul className="chat-ring-cats">
            {context.categories.map((category) => (
              <li key={category.name}>
                <span>{category.name}</span>
                <span className="chat-file-counts">
                  {tokens(category.tokens)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {context.compacts_at != null && (
          <p className="chat-plan-note">
            Compacts at {tokens(context.compacts_at)}
          </p>
        )}
        {context.compacted_at != null && (
          <p className="chat-plan-note">
            Compacted at {clockTime(context.compacted_at)}.
          </p>
        )}
        {stale && (
          <p className="chat-plan-note">As of {clockTime(context.at)}</p>
        )}
      </PopoverContent>
    </Popover>
  );
}
