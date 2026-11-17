import { useContext, type ReactNode } from "react";
import { HiddenContext } from "./visibility-context";

/**
 * Marks a subtree that is mounted but not shown. Reads below it make no calls
 * and keep their last value, then catch up once when it is shown again.
 */
export function Visibility({
  hidden,
  children,
}: {
  hidden: boolean;
  children: ReactNode;
}) {
  const outer = useContext(HiddenContext);
  return (
    <HiddenContext.Provider value={outer || hidden}>
      {children}
    </HiddenContext.Provider>
  );
}
