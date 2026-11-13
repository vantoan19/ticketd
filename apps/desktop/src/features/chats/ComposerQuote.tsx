import { X } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import type { Quote } from "@/features/chats/quotes";

/**
 * Quotes waiting in the composer: a muted source line, with Remove quote on
 * hover or focus, over two clamped lines beside a rule. No card: the composer
 * stays the only box. A long selection is kept whole and says how long it is.
 */
export function ComposerQuotes({
  quotes,
  onRemove,
}: {
  quotes: Quote[];
  onRemove: (id: string) => void;
}) {
  if (quotes.length === 0) return null;
  return (
    <ul className="chat-quotes" aria-label="Quotes">
      {quotes.map((quote) => {
        const lines = quote.text.split("\n").length;
        return (
          <li key={quote.id} className="chat-quote">
            <div className="chat-quote-source">
              <span>{quote.source}</span>
              <IconButton
                type="button"
                label="Remove quote"
                className="chat-quote-remove"
                onClick={() => onRemove(quote.id)}
              >
                <X aria-hidden />
              </IconButton>
            </div>
            <p className="chat-quote-text">{quote.text}</p>
            {lines > 2 && <span className="chat-quote-lines">{lines} lines</span>}
          </li>
        );
      })}
    </ul>
  );
}
