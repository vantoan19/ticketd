import { useCallback } from "react";
import { readKey, type ReadSpec } from "./catalog";
import { useReads } from "./reads-context";

/**
 * A peek at what `spec` has cached: the newest value known for the arguments, or
 * undefined when nothing was read. It reads the cache as it is now, starts no
 * read and does not observe the entry, so the view does not re-render when the
 * value changes; ask again where the value is needed (an event handler, or a
 * render that happens anyway). The function is stable.
 */
export function useKnown<A, V>(
  spec: ReadSpec<A, V>,
): (args: A) => V | undefined {
  const reads = useReads("useKnown");
  return useCallback(
    (args) => reads.peek(readKey(spec, args)) as V | undefined,
    [reads, spec],
  );
}
