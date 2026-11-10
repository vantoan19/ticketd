import { useEffect, useRef, useState, type ReactNode } from "react";
import { contextRecords, type ContextKey } from "./factoryRecords";
import plates from "./FactoryPlates.markup.json";

function Example({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="pd-example" role="region" aria-label={title}>
      <div className="pd-example-bar">
        <b>ticketd</b>
        <span>{title}</span>
        <span className="pd-local">● Local</span>
      </div>
      {children}
    </div>
  );
}

const tickets = [
  {
    id: "T-12",
    title: "Rate-limit failed login attempts",
    short: "Rate-limit logins",
    status: "In review",
    description:
      "Protect accounts from repeated attempts, without locking out their owners.",
    document: "Login hardening spec",
    context:
      "Allow 5 failed attempts per 15 minutes. Apply the limit by account and IP address.",
    linked: "One spec, shared by T-12 and T-13.",
  },
  {
    id: "T-13",
    title: "Alert on-call when failed logins spike",
    short: "Alert on-call",
    status: "Blocked by T-12",
    description: "Notify the on-call team when failed login attempts spike.",
    document: "Login hardening spec",
    context:
      "Allow 5 failed attempts per 15 minutes. Apply the limit by account and IP address.",
    linked: "One spec, shared by T-12 and T-13.",
  },
  {
    id: "T-14",
    title: "Show the remaining wait time",
    short: "Show wait time",
    status: "Todo",
    description: "Help people understand when they can try signing in again.",
    document: "Login form design",
    context:
      "Use the Retry-After value to show a clear wait message beside the login form.",
    linked: "Design context, attached to T-14.",
  },
] as const;

export function WorkExample() {
  const [selected, setSelected] = useState(0);
  const ticket = tickets[selected] ?? tickets[0];
  return (
    <Example title="Tickets & context">
      <div className="pd-work">
        <div className="pd-ticket-list">
          <p className="pd-label">PLAN</p>
          <h3>Login hardening</h3>
          <div role="group" aria-label="Tickets in the plan">
            {tickets.map((item, index) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={selected === index}
                onClick={() => setSelected(index)}
              >
                <span>{item.id}</span>
                <b>{item.short}</b>
                <small>{item.status}</small>
              </button>
            ))}
          </div>
        </div>
        <article
          className="pd-ticket"
          aria-label="Selected ticket"
          aria-live="polite"
        >
          <div className="pd-ticket-meta">
            <span>{ticket.id}</span>
            <span className="pd-status">{ticket.status}</span>
          </div>
          <h3>{ticket.title}</h3>
          <p>{ticket.description}</p>
          <div className="pd-context-path" aria-hidden="true">
            <span /> <i /> <span />
          </div>
          <div className="pd-context-paper">
            <p className="pd-label">LINKED CONTEXT</p>
            <h4>
              <span aria-hidden="true">▤</span> {ticket.document}
            </h4>
            <p>{ticket.context}</p>
          </div>
          <p className="pd-example-note">{ticket.linked}</p>
        </article>
      </div>
    </Example>
  );
}

export function AgentUpdateExample() {
  const [reviewed, setReviewed] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  return (
    <Example title="Agent activity">
      <div className="pd-update">
        <div className="pd-ticket-meta">
          <span>T-12</span>
          <span className="pd-status">{reviewed ? "Done" : "In review"}</span>
        </div>
        <h3>Rate-limit failed login attempts</h3>
        <div className="pd-report">
          <span className="pd-agent-avatar" aria-hidden="true">
            AI
          </span>
          <div>
            <p className="pd-report-author">
              <b>coding-agent</b>
              <span>reported an update</span>
            </p>
            <p>
              Account and IP limits are implemented. Checks passed. Ready for
              your review.
            </p>
            <div className="pd-evidence">
              <button
                type="button"
                aria-expanded={evidenceOpen}
                aria-controls="review-evidence"
                onClick={() => setEvidenceOpen(!evidenceOpen)}
              >
                Pull request #87 ↗
              </button>
              <span>✓ Checks passed</span>
            </div>
            {evidenceOpen && (
              <div
                id="review-evidence"
                className="pd-source"
                role="region"
                aria-label="Review evidence"
              >
                <p>
                  PR #87 implements account and IP limits from the Login
                  hardening spec.
                </p>
                <p>
                  ✓ Five attempts per fifteen minutes
                  <br />✓ 429 response with Retry-After
                  <br />✓ Limiter checks passed
                </p>
              </div>
            )}
          </div>
        </div>
        <div className="pd-review" aria-live="polite">
          <div>
            <b>
              {reviewed
                ? "Reviewed by you."
                : "Your decision, with the evidence at hand."}
            </b>
            <p>
              {reviewed
                ? "T-12 is complete. T-13 is ready to start."
                : "The update, the change and its checks stay on the ticket."}
            </p>
          </div>
          <button
            type="button"
            className={reviewed ? "st-link" : "st-btn st-btn-primary"}
            onClick={() => {
              setReviewed(!reviewed);
              if (reviewed) setEvidenceOpen(false);
            }}
          >
            {reviewed ? "Reset example" : "Mark reviewed"}
          </button>
        </div>
        {reviewed && <span className="pd-paw-stamp">PAWPROVED</span>}
        <svg
          className="x-art pd-supervisor"
          viewBox="80 170 150 140"
          aria-hidden="true"
        >
          <g dangerouslySetInnerHTML={{ __html: plates.hero.cat }} />
        </svg>
      </div>
    </Example>
  );
}

const questions = [
  {
    title: "What changed on T-12?",
    answer:
      "The rate limiter is ready for review. Your agent linked PR #87 and reported passing checks. T-13 is waiting for you to review T-12.",
    sources: ["update", "evidence"] as ContextKey[],
  },
  {
    title: "Why limit by account and IP?",
    answer:
      "The investigation found attempts from both a single IP and rotating IPs. The spec calls for both limits, while avoiding a permanent lockout for the account owner.",
    sources: ["spec", "notes"] as ContextKey[],
  },
  {
    title: "What should I do next?",
    answer:
      "Review PR #87 against the spec: five attempts, a fifteen-minute window, and a clear wait message. Link your review to T-12 so the next person or agent can follow the decision.",
    sources: ["spec", "evidence"] as ContextKey[],
  },
] as const;

export function AssistantExample() {
  const [questionIndex, setQuestionIndex] = useState(0);
  const [source, setSource] = useState<ContextKey | null>(null);
  const [draft, setDraft] = useState<"none" | "preview" | "added">("none");
  const draftAction = useRef<HTMLButtonElement>(null);
  const draftingStarted = useRef(false);
  const question = questions[questionIndex] ?? questions[0];
  useEffect(() => {
    if (draftingStarted.current) draftAction.current?.focus();
  }, [draft]);
  return (
    <Example title="AI assistant">
      <div className="pd-chat">
        <div
          className="pd-questions"
          role="group"
          aria-label="Ask the assistant"
        >
          {questions.map((item, index) => (
            <button
              key={item.title}
              type="button"
              aria-pressed={questionIndex === index}
              onClick={() => {
                setQuestionIndex(index);
                setSource(null);
              }}
            >
              {item.title}
            </button>
          ))}
        </div>
        <div className="pd-answer" aria-live="polite">
          <p className="pd-label">TICKETD ASSISTANT</p>
          <p>{question.answer}</p>
          <div
            className="pd-citations"
            role="group"
            aria-label="Answer sources"
          >
            {question.sources.map((key, index) => (
              <button
                key={key}
                type="button"
                aria-expanded={source === key}
                aria-controls="assistant-source"
                onClick={() => setSource(source === key ? null : key)}
              >
                [{index + 1}] {contextRecords[key].title} ↗
              </button>
            ))}
          </div>
          {source && (
            <blockquote
              id="assistant-source"
              className="pd-source"
              aria-label={contextRecords[source].title}
            >
              <p>{contextRecords[source].body}</p>
              <cite>{contextRecords[source].title}</cite>
            </blockquote>
          )}
        </div>
        <div className="pd-draft-area">
          {draft === "none" ? (
            <button
              type="button"
              className="st-link"
              ref={draftAction}
              onClick={() => {
                draftingStarted.current = true;
                setDraft("preview");
              }}
            >
              Draft a review ticket →
            </button>
          ) : draft === "preview" ? (
            <div
              className="pd-draft"
              role="region"
              aria-label="Proposed ticket"
            >
              <p className="pd-label">TICKET DRAFT</p>
              <h4>Review login rate limiting</h4>
              <p>
                Check PR #87 against the spec. Keep the review linked to T-12.
              </p>
              <div className="pd-draft-actions">
                <button
                  type="button"
                  className="st-btn st-btn-primary"
                  ref={draftAction}
                  onClick={() => setDraft("added")}
                >
                  Add to Plan
                </button>
                <button
                  type="button"
                  className="st-link"
                  onClick={() => setDraft("none")}
                >
                  Discard
                </button>
              </div>
            </div>
          ) : (
            <div className="pd-added" role="status">
              <p>
                ✓ T-18 added to Login hardening, with the spec and PR #87
                linked.
              </p>
              <button
                type="button"
                className="st-link"
                ref={draftAction}
                onClick={() => setDraft("none")}
              >
                Reset example
              </button>
            </div>
          )}
        </div>
      </div>
    </Example>
  );
}
