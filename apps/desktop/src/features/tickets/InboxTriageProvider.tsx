import { useStatusLine } from "@/components/ui/use-status-line";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  InboxTriageContext,
  type TriageSelection,
} from "./inbox-triage-context";
export function InboxTriageProvider({
  active,
  children,
  onSelectionChange,
}: {
  active: boolean;
  children: ReactNode;
  onSelectionChange?: (selection: TriageSelection | null) => void;
}) {
  const line = useStatusLine();
  const [wasActive, setWasActive] = useState(active);
  const [selection, choose] = useState<TriageSelection | null>(null);
  const [chatId, openChat] = useState<string | null>(null);
  const [position, storePosition] = useState<{
    index: number;
    total: number;
  } | null>(null);
  const setPosition = useCallback(
    (next: { index: number; total: number } | null) => {
      storePosition((previous) =>
        previous?.index === next?.index && previous?.total === next?.total
          ? previous
          : next,
      );
    },
    [],
  );
  const walk = useRef<(direction: 1 | -1) => void>(() => {});
  const adjacent = useCallback(
    (direction: 1 | -1) => walk.current(direction),
    [],
  );
  const registerWalk = useCallback((callback: (direction: 1 | -1) => void) => {
    walk.current = callback;
  }, []);
  useEffect(() => {
    onSelectionChange?.(active ? selection : null);
  }, [active, selection, onSelectionChange]);
  if (wasActive !== active) {
    setWasActive(active);
    choose(null);
    openChat(null);
    setPosition(null);
  }
  return (
    <InboxTriageContext
      value={{
        selection: active ? selection : null,
        line,
        choose,
        chatId: active ? chatId : null,
        openChat,
        position,
        setPosition,
        adjacent,
        registerWalk,
      }}
    >
      {children}
    </InboxTriageContext>
  );
}
