// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Settings } from "lucide-react";
import { useState } from "react";
import { afterEach, expect, test } from "vitest";
import { Button } from "@/components/ui/button";
import { SettingsPage } from "@/features/settings/layout/SettingsPage";
import { SettingsSection } from "@/features/settings/layout/SettingsSection";

afterEach(cleanup);

/** A two-step flow whose Continue button goes away, as the sync steps do. */
function Flow({ marked }: { marked: boolean }) {
  const [step, setStep] = useState(1);
  return (
    <SettingsPage group="Workspace" label="Flow" icon={Settings}>
      {step === 1 ? (
        <SettingsSection title="First step" focusTarget={marked}>
          <Button onClick={() => setStep(2)}>Continue</Button>
        </SettingsSection>
      ) : (
        <SettingsSection title="Second step" focusTarget={marked}>
          <p>Done.</p>
        </SettingsSection>
      )}
    </SettingsPage>
  );
}

test("when an in-place action removes the focused button, focus lands on the new step's heading", async () => {
  render(<Flow marked />);
  const button = screen.getByRole("button", { name: "Continue" });
  button.focus();
  fireEvent.focusIn(button);
  // Clicking an already focused control fires no focus event.
  fireEvent.pointerDown(button);
  fireEvent.click(button);
  const heading = await screen.findByRole("heading", { name: "Second step" });
  await waitFor(() => expect(document.activeElement).toBe(heading));
});

test("without a marked step, focus falls back to the page title", async () => {
  render(<Flow marked={false} />);
  const button = screen.getByRole("button", { name: "Continue" });
  button.focus();
  fireEvent.focusIn(button);
  fireEvent.click(button);
  await screen.findByRole("heading", { name: "Second step" });
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 1, name: "Flow" }),
    ),
  );
});

test("focus the person moved elsewhere is left alone", async () => {
  render(<Flow marked />);
  const button = screen.getByRole("button", { name: "Continue" });
  button.focus();
  fireEvent.focusIn(button);
  // A click on empty space, then the button goes away.
  fireEvent.pointerDown(document.body);
  button.blur();
  fireEvent.click(button);
  await screen.findByRole("heading", { name: "Second step" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(document.activeElement).toBe(document.body);
});
