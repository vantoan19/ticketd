import { useRef } from "react";

/**
 * A request id for each distinct thing a dialog submits. The core recognises a
 * repeated id, so submitting the same content again (after a lost answer, say)
 * is not applied twice, while changed content is a new request.
 */
export function useRequestIds(): (content: unknown) => string {
  const ids = useRef(new Map<string, string>());
  return (content) => {
    const key = JSON.stringify(content);
    const id = ids.current.get(key) ?? crypto.randomUUID();
    ids.current.set(key, id);
    return id;
  };
}
