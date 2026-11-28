import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { currentHeading, OUTLINE_MINIMUM } from "@/features/markdown/outline";
import { revealTicketDescription } from "./description-navigation";

type Heading = { offset: number; text: string; level: number };

export function TicketOutline({
  column,
  ticketId,
}: {
  column: RefObject<HTMLDivElement | null>;
  ticketId: string;
}) {
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [current, setCurrent] = useState<number>();
  const chosen = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    const content = column.current;
    const scroller = content?.closest<HTMLElement>(".detail-scroll");
    if (!content || !scroller) return;

    let elements: HTMLElement[] = [];
    function measure() {
      if (!scroller || elements.length < OUTLINE_MINIMUM) return;
      const line = scroller.getBoundingClientRect().top + 48;
      const offsets = elements.map((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.height > 0 && !element.closest("[hidden]")
          ? bounds.top
          : Number.POSITIVE_INFINITY;
      });
      const index = currentHeading(offsets, line);
      const visible =
        index === null
          ? undefined
          : Number(elements[index]?.dataset.headingOffset);
      setCurrent(chosen.current ?? visible);
      if (chosen.current === visible) chosen.current = undefined;
    }
    let frame = 0;
    const queueMeasure = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    const read = () => {
      // Folded sections keep their headings in the DOM, so a heading can take
      // the reader to a section whose disclosure has not been opened yet.
      elements = Array.from(
        content.querySelectorAll<HTMLElement>(
          ".ticket-description [data-heading-offset]",
        ),
      );
      const next = elements.map((element) => ({
        offset: Number(element.dataset.headingOffset),
        text: element.textContent?.trim() || "Untitled section",
        level: Number(element.tagName.slice(1)),
      }));
      setHeadings((previous) =>
        previous.length === next.length &&
        previous.every(
          (heading, i) =>
            heading.offset === next[i]?.offset &&
            heading.text === next[i].text &&
            heading.level === next[i].level,
        )
          ? previous
          : next,
      );
      measure();
    };
    const release = () => {
      chosen.current = undefined;
      queueMeasure();
    };
    const mutations = new MutationObserver(read);
    mutations.observe(content, {
      childList: true,
      subtree: true,
      characterData: true,
      attributeFilter: ["hidden", "data-heading-offset"],
    });
    const sizes =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(queueMeasure);
    sizes?.observe(content);
    sizes?.observe(scroller);
    scroller.addEventListener("scroll", queueMeasure, { passive: true });
    const inputEvents = ["wheel", "touchstart", "pointerdown", "keydown"];
    for (const type of inputEvents)
      scroller.addEventListener(type, release, { passive: true });
    read();
    return () => {
      mutations.disconnect();
      sizes?.disconnect();
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", queueMeasure);
      for (const type of inputEvents)
        scroller.removeEventListener(type, release);
    };
  }, [column]);

  if (headings.length < OUTLINE_MINIMUM) return null;
  const sectionLevel = Math.max(
    2,
    Math.min(...headings.map(({ level }) => level)),
  );
  return (
    <nav className="ticket-outline" aria-label="On this page">
      <h2 className="ticket-rail-heading">On this page</h2>
      <ul>
        {headings.map(({ text, level, offset }) => (
          <li key={offset} data-subsection={level > sectionLevel || undefined}>
            <Button
              type="button"
              variant="ghost"
              size="compact"
              aria-current={current === offset ? "location" : undefined}
              onClick={() => {
                chosen.current = offset;
                setCurrent(offset);
                revealTicketDescription(ticketId, { headingOffset: offset });
              }}
            >
              {text}
            </Button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
