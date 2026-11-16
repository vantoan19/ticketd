import { fireEvent, screen, within } from "@testing-library/react";

export async function selectAutomationView(
  name: "Automations" | "Agents" | "Runs",
) {
  const list = screen.getByRole("region", {
    name: /^(Automation|Agent|Run) list$/,
  });
  fireEvent.keyDown(
    within(list).getByRole("button", { name: /^(Automations|Agents|Runs)/ }),
    { key: "Enter" },
  );
  fireEvent.click(
    await screen.findByRole("menuitemradio", { name: new RegExp(`^${name}`) }),
  );
}
