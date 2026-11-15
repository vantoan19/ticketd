import { useEffect, useState } from "react";
import { Inbox } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Item } from "@/components/ui/item";
import { Reference } from "@/components/ui/reference";
import { useChatClient, type Suggestion } from "@/features/chats/client";
import { chatTime } from "@/features/chats/model";
import { StatusIcon } from "@/features/tickets/StatusIcon";

/** Placeholders show only when suggestions take longer than this. */
const SLOW_MS = 300;

function Row({
  suggestion,
  onChoose,
}: {
  suggestion: Suggestion;
  onChoose: () => void;
}) {
  const time = suggestion.at ? chatTime(suggestion.at) : "";
  return (
    <li>
      <Item asChild>
        <button type="button" className="chat-suggestion" onClick={onChoose}>
          {suggestion.kind === "triage" ? (
            <>
              <Inbox size={16} aria-hidden />
              <span>Triage the Inbox ({suggestion.count})</span>
            </>
          ) : (
            <>
              <StatusIcon status={suggestion.ticket.status} decorative />
              <span className="chat-suggestion-words">
                {suggestion.kind === "continue" ? "Continue" : "Review"}{" "}
                <Reference>{suggestion.ticket.reference}</Reference>{" "}
                <span className="chat-suggestion-title">
                  {suggestion.ticket.title}
                </span>
              </span>
            </>
          )}
          {time && <span className="chat-fine">{time}</span>}
        </button>
      </Item>
    </li>
  );
}

/**
 * Up to three things to start from, chosen by the host from local records for the
 * chosen folder. Choosing one never sends: New Chat fills the box and links.
 */
export function Suggestions({
  folder,
  linked,
  onChoose,
  refresh = 0,
}: {
  folder: string | null;
  /** Rises when New Chat is asked for again: suggestions are asked again. */
  refresh?: number;
  /** Tickets already linked to the New Chat; the host leaves them out. */
  linked: string[];
  onChoose: (suggestion: Suggestion) => void;
}) {
  const client = useChatClient();
  const [found, setFound] = useState<Suggestion[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const key = linked.join(" ");
  const request = `${attempt + refresh} ${folder ?? ""} ${key}`;
  /** The request that has taken longer than SLOW_MS so far. */
  const [slowFor, setSlowFor] = useState("");
  const slow = slowFor === request;
  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(
      () => current && setSlowFor(request),
      SLOW_MS,
    );
    client.suggestions(folder, key ? key.split(" ") : []).then(
      (list) => {
        if (!current) return;
        setFound(list);
        setFailed(false);
      },
      () => {
        if (!current) return;
        setFound(null);
        setFailed(true);
      },
    );
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [client, folder, key, request]);
  if (failed)
    return (
      <p className="chat-fine chat-suggestions-failed">
        Couldn't load suggestions.{" "}
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setAttempt((count) => count + 1)}
        >
          Try again
        </Button>
      </p>
    );
  if (!found)
    return slow ? (
      <div className="chat-suggestions" aria-hidden="true">
        <div className="chat-skel chat-suggestion-skel" />
        <div className="chat-skel chat-suggestion-skel" />
      </div>
    ) : null;
  if (found.length === 0) return null;
  return (
    <section className="chat-suggestions" aria-labelledby="chat-suggested">
      <h3 id="chat-suggested" className="chat-fine">
        Suggested
      </h3>
      <ul>
        {found.map((suggestion) => (
          <Row
            key={
              suggestion.kind === "triage"
                ? "triage"
                : `${suggestion.kind}:${suggestion.ticket.id}`
            }
            suggestion={suggestion}
            onChoose={() => onChoose(suggestion)}
          />
        ))}
      </ul>
    </section>
  );
}
