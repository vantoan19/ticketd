import { useState, type ComponentProps } from "react";
import { AutomationEditor } from "@/features/automations/AutomationEditor";
import type { AutomationDefinition } from "@/features/automations/client";
import { fakeStored } from "@/features/automations/fake-core";

/**
 * For tests of the editor alone: it is given back what it saves, as the page
 * does after the core answers. `onSaved` is told each definition saved.
 */
export function EditorUnderTest({
  automation: first,
  onSaved,
  ...props
}: Omit<ComponentProps<typeof AutomationEditor>, "onChange"> & {
  onSaved: (definition: AutomationDefinition, typing: boolean) => void;
}) {
  const [automation, setAutomation] = useState(() => fakeStored(first, {}));
  return (
    <AutomationEditor
      {...props}
      automation={automation}
      onChange={async (definition, typing) => {
        onSaved(definition, typing);
        const stored = fakeStored(automation, definition);
        setAutomation(stored);
        return stored;
      }}
    />
  );
}
