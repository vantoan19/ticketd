import { useState } from "react";
import { ContextArchive, AssistantWorkbench } from "./FactoryPlates";
import { contextRecords, contextKeys, type ContextKey } from "./factoryRecords";

function ContextPreview({
  selected,
  compact = false,
}: {
  selected: ContextKey;
  compact?: boolean;
}) {
  const record = contextRecords[selected];
  return (
    <article
      className={`fw-document${compact ? " fw-document-compact" : ""}`}
      aria-label={record.title}
    >
      <p className="fw-eyebrow">{record.kind}</p>
      <h3>{record.title}</h3>
      <p>{record.body}</p>
      {!compact && <p className="fw-document-note">{record.detail}</p>}
      <div className="fw-linked">
        <span>Linked work</span>
        {record.tickets.map((ticket) => (
          <span className="fw-ticket-tag" key={ticket}>
            {ticket}
          </span>
        ))}
      </div>
    </article>
  );
}

export function ContextLibrary() {
  const [selected, setSelected] = useState<ContextKey>("spec");
  const [packed, setPacked] = useState<ContextKey[]>([
    "spec",
    "notes",
    "update",
    "evidence",
  ]);
  const [packRun, setPackRun] = useState(0);
  const sent = packRun > 0;
  const prepare = () => {
    if (packed.length) setPackRun((run) => run + 1);
  };
  const toggle = (key: ContextKey) => {
    setPacked((current) =>
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key],
    );
    setPackRun(0);
  };
  return (
    <section
      id="context"
      className="st-sec fw-section"
      data-sheet="context"
      aria-labelledby="fw-context-title"
    >
      <div className="st-sec-head">
        <div>
          <p className="st-kicker">
            <b>03</b> · The context store
          </p>
          <h2 className="st-h2" id="fw-context-title">
            Good work starts with
            <br />
            <span className="st-accent">the whole story.</span>
          </h2>
        </div>
        <p className="st-lead">
          Keep specs, decisions and evidence connected to the work. Reuse the
          same Documents across tickets, then give the next agent session the
          context it needs.
        </p>
      </div>
      <ContextArchive selected={selected} packed={packed} packRun={packRun} />
      <div className="fw-library st-win">
        <div className="st-win-bar">
          <span>ticketd · context library</span>
          <span>One source, connected to the work</span>
        </div>
        <div
          className="fw-record-list"
          role="group"
          aria-label="Context records"
        >
          {contextKeys.map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={key === selected}
              onClick={() => setSelected(key)}
            >
              <span>
                {key === "update" ? "↳" : key === "evidence" ? "↗" : "▤"}
              </span>
              <span>
                <b>
                  {
                    {
                      spec: "Specification",
                      notes: "Investigation",
                      update: "Agent update",
                      evidence: "Evidence",
                    }[key]
                  }
                </b>
              </span>
            </button>
          ))}
        </div>
        <div className="fw-library-body">
          <ContextPreview selected={selected} />
        </div>
      </div>
      <details className="st-details">
        <summary>
          View details <span>Prepare context for the next agent session</span>
        </summary>
        <div className="st-details-body">
          <aside className="fw-packing">
            <p className="fw-eyebrow">PACK FOR THE NEXT SESSION</p>
            <h3>T-12 / Context</h3>
            <div className="fw-checks">
              {contextKeys.map((key) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={packed.includes(key)}
                    onChange={() => toggle(key)}
                  />
                  {contextRecords[key].title}
                </label>
              ))}
            </div>
            <button
              type="button"
              className="st-btn st-btn-primary"
              disabled={!packed.length}
              onClick={prepare}
            >
              Prepare context →
            </button>
            <p className="fw-packing-result" role="status">
              {sent
                ? `${packed.length} records ready.`
                : `${packed.length} records selected`}
            </p>
            {sent && (
              <div
                className="fw-packet"
                role="region"
                aria-label="Prepared context"
              >
                <ul>
                  {packed.map((key) => (
                    <li key={key}>✓ {contextRecords[key].title}</li>
                  ))}
                </ul>
              </div>
            )}
          </aside>
        </div>
      </details>
    </section>
  );
}

const questions = [
  {
    question: "What changed on T-12?",
    answer:
      "The limiter is ready for review. The agent reports passing tests and has linked PR #87. T-13 still waits for T-12 to be completed.",
    sources: ["update", "evidence"] as ContextKey[],
  },
  {
    question: "Why limit by account and IP?",
    answer:
      "The investigation found both repeated attempts from one IP and attempts from rotating IPs. The spec calls for both limits. The investigation also cautions against a permanent lockout that could block the account owner.",
    sources: ["spec", "notes"] as ContextKey[],
  },
  {
    question: "What should I check next?",
    answer:
      "Review PR #87 against the spec. Check the five-attempt limit, the fifteen-minute window, and how the login form explains the wait. Keep that review linked to T-12.",
    sources: ["spec", "evidence"] as ContextKey[],
  },
] as const;

export function AssistantDesk() {
  const [questionIndex, setQuestionIndex] = useState(0);
  const [source, setSource] = useState<ContextKey>("update");
  const [draft, setDraft] = useState<"none" | "preview" | "added">("none");
  const [automation, setAutomation] = useState(false);
  const [notice, setNotice] = useState(false);
  const question = questions[questionIndex] ?? questions[0];
  const inspectSource = (key: ContextKey) => {
    setSource(key);
  };
  const addDraft = () => {
    setDraft("added");
  };
  const toggleAutomation = () => {
    setAutomation(!automation);
    setNotice(false);
  };
  const reset = () => {
    setQuestionIndex(0);
    setSource("update");
    setDraft("none");
    setAutomation(false);
    setNotice(false);
  };
  return (
    <section
      id="assistant"
      className="st-sec fw-section"
      data-sheet="assistant"
      aria-labelledby="fw-assistant-title"
    >
      <div className="st-sec-head">
        <div>
          <p className="st-kicker">
            <b>04</b> · The assistant’s desk
          </p>
          <h2 className="st-h2" id="fw-assistant-title">
            Ask about the work.
            <br />
            <span className="st-accent">Move it forward.</span>
          </h2>
        </div>
        <p className="st-lead">
          Chat with AI that has your tickets, context and updates at hand. Turn
          an answer into a useful next step, and let automations keep the
          routine work moving.
        </p>
      </div>
      <AssistantWorkbench
        source={source}
        sources={question.sources}
        questionIndex={questionIndex}
        draft={draft}
        automation={automation}
        notice={notice}
      />
      <div className="fw-assistant st-win">
        <div className="st-win-bar">
          <span>ticketd · AI assistant / Login hardening</span>
        </div>
        <div className="fw-assistant-body">
          <div className="fw-chat">
            <div
              className="fw-questions"
              role="group"
              aria-label="Ask the ticketd assistant"
            >
              {questions.map((item, index) => (
                <button
                  key={item.question}
                  type="button"
                  aria-pressed={index === questionIndex}
                  onClick={() => {
                    setQuestionIndex(index);
                    inspectSource(item.sources[0] ?? "spec");
                  }}
                >
                  {item.question}
                </button>
              ))}
            </div>
            <div className="fw-answer" aria-live="polite">
              <p className="fw-eyebrow">TICKETD ASSISTANT</p>
              <p>{question.answer}</p>
              <div
                className="fw-citations"
                role="group"
                aria-label="Answer sources"
              >
                {question.sources.map((key, index) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={key === source}
                    onClick={() => inspectSource(key)}
                  >
                    [{index + 1}] {contextRecords[key].title} ↗
                  </button>
                ))}
              </div>
            </div>
          </div>
          <aside className="fw-source">
            <p className="fw-eyebrow">SOURCE</p>
            <ContextPreview selected={source} compact />
          </aside>
        </div>
      </div>
      <details className="st-details">
        <summary>
          View details <span>Turn an answer into a ticket or automation</span>
        </summary>
        <div className="st-details-body">
          <div className="fw-draft-example">
            <div className="fw-draft-action">
              {draft === "none" ? (
                <button
                  type="button"
                  className="st-btn st-btn-ghost"
                  onClick={() => setDraft("preview")}
                >
                  Draft a review ticket →
                </button>
              ) : (
                <p>
                  {draft === "preview"
                    ? "Review the proposed ticket before adding it to your Plan."
                    : "The new ticket keeps its supporting context."}
                </p>
              )}
            </div>
            {draft !== "none" && (
              <div className="fw-draft" aria-label="Review ticket draft">
                <div>
                  <span className="fw-eyebrow">
                    {draft === "added"
                      ? "ADDED TO LOGIN HARDENING"
                      : "TICKET DRAFT"}
                  </span>
                  <b>
                    {draft === "added" ? "T-18 · " : ""}Review login rate
                    limiting
                  </b>
                  <p>
                    Check the limit and wait message against the spec. Related
                    to T-12 · 2 context links.
                  </p>
                </div>
                {draft === "preview" ? (
                  <div className="fw-actions">
                    <button
                      type="button"
                      className="st-btn st-btn-primary"
                      onClick={addDraft}
                    >
                      Add to Plan
                    </button>
                    <button
                      type="button"
                      className="st-link"
                      onClick={() => {
                        setDraft("none");
                      }}
                    >
                      Discard draft
                    </button>
                  </div>
                ) : (
                  <p role="status" className="fw-success">
                    ✓ T-18 added with the spec and PR #87 linked.
                  </p>
                )}
              </div>
            )}
          </div>
          <div className="fw-automation">
            <label>
              <input
                type="checkbox"
                checked={automation}
                onChange={toggleAutomation}
              />
              <span>
                <b>When a ticket needs review</b>
                <small>Summarize the change and notify me.</small>
              </span>
            </label>
            <button
              type="button"
              className="st-btn st-btn-ghost"
              disabled={!automation || notice}
              onClick={() => setNotice(true)}
            >
              {notice ? "Update received" : "Try an agent update"}
            </button>
            <p role="status">
              {notice
                ? "Inbox · T-12 needs review. Limiter checks pass; PR #87 is attached."
                : automation
                  ? "Automation on · waiting for an update"
                  : "Turn on the rule to try it."}
            </p>
          </div>
          <button type="button" className="st-link fw-reset" onClick={reset}>
            Reset example
          </button>
        </div>
      </details>
    </section>
  );
}

export function StoragePreview() {
  const [selected, setSelected] = useState<"spec" | "notes">("spec");
  return (
    <div className="fw-storage">
      <div className="fw-eyebrow">DOCUMENTS / CONNECTED STORAGE</div>
      <div
        className="fw-storage-files"
        role="group"
        aria-label="Storage documents"
      >
        {(["spec", "notes"] as const).map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={selected === key}
            onClick={() => setSelected(key)}
          >
            <b>▤ {contextRecords[key].title}</b>
            <span>Google Drive → Document</span>
          </button>
        ))}
      </div>
      <ContextPreview selected={selected} compact />
    </div>
  );
}

export function ConnectedWorkspace() {
  const [localTitle, setLocalTitle] = useState(false);
  const [remoteTitle, setRemoteTitle] = useState(false);
  const pending = localTitle !== remoteTitle;
  return (
    <div className="fw-sync" role="group" aria-label="Local workspace and sync">
      <div>
        <span className="fw-eyebrow">YOUR COMPUTER</span>
        <b>
          T-12 ·{" "}
          {localTitle
            ? "Review login rate limiting"
            : "Rate-limit failed login attempts"}
        </b>
        <span className="fw-sync-state">
          ● Saved locally{pending ? " · 1 change to sync" : ""}
        </span>
      </div>
      <div className="fw-sync-controls">
        <button
          type="button"
          className="st-link"
          onClick={() => setLocalTitle(!localTitle)}
        >
          {localTitle ? "Restore title locally" : "Edit title locally"}
        </button>
        <button
          type="button"
          className="st-btn st-btn-ghost"
          disabled={!pending}
          onClick={() => setRemoteTitle(localTitle)}
        >
          {pending ? "Sync change →" : "✓ Synced"}
        </button>
      </div>
      <div>
        <span className="fw-eyebrow">YOUR OTHER WORKSPACE</span>
        <b>
          T-12 ·{" "}
          {remoteTitle
            ? "Review login rate limiting"
            : "Rate-limit failed login attempts"}
        </b>
        <span className="fw-sync-state" role="status">
          {pending
            ? "Waiting for your local change"
            : "Same tickets. Same context."}
        </span>
      </div>
    </div>
  );
}
