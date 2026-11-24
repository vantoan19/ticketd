import { useHarnessCatalog } from "./harness-catalog";

/** Only a name declared by a harness earns its publisher mark. */
export function useEditingHarness() {
  const catalog = useHarnessCatalog();
  return (agent: string | null | undefined) => {
    const name = agent?.trim().toLowerCase();
    return name
      ? (catalog.find((entry) => entry.editing_agent_aliases.includes(name))
          ?.id ?? null)
      : null;
  };
}
