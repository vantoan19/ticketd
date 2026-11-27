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
import { createPortal } from "react-dom";
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

/**
 * A step with a Disconnect… button whose confirm lives in a portal outside the
 * page, as a dialog does. Confirming swaps the step; the dialog goes later
 * (its exit animation), or at the same moment.
 */
function Confirming({ dialogLingers }: { dialogLingers: boolean }) {
  const [step, setStep] = useState(1);
  const [open, setOpen] = useState(false);
  return (
    <SettingsPage group="Workspace" label="Flow" icon={Settings}>
      {step === 1 ? (
        <SettingsSection title="Syncing" focusTarget>
          <Button onClick={() => setOpen(true)}>Disconnect…</Button>
        </SettingsSection>
      ) : (
        <SettingsSection title="Start or join" focusTarget>
          <p>Done.</p>
        </SettingsSection>
      )}
      {open &&
        createPortal(
          <div role="alertdialog" aria-label="Disconnect">
            <button
              type="button"
              onClick={() => {
                setStep(2);
                if (dialogLingers) setTimeout(() => setOpen(false), 10);
                else setOpen(false);
              }}
            >
              Disconnect
            </button>
          </div>,
          document.body,
        )}
    </SettingsPage>
  );
}

test.each([true, false])(
  "focus the confirm of a dialog opened from the page held falls on the new step (dialog lingers: %s)",
  async (dialogLingers) => {
    render(<Confirming dialogLingers={dialogLingers} />);
    const open = screen.getByRole("button", { name: "Disconnect…" });
    open.focus();
    fireEvent.focusIn(open);
    fireEvent.pointerDown(open);
    fireEvent.click(open);
    const confirm = await screen.findByRole("button", { name: "Disconnect" });
    confirm.focus();
    fireEvent.focusIn(confirm);
    fireEvent.pointerDown(confirm);
    fireEvent.click(confirm);
    const heading = await screen.findByRole("heading", {
      name: "Start or join",
    });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  },
);

test("a dialog from elsewhere leaves the focus it drops alone", async () => {
  render(<Confirming dialogLingers={false} />);
  const open = screen.getByRole("button", { name: "Disconnect…" });
  open.focus();
  fireEvent.focusIn(open);
  const outside = document.createElement("div");
  outside.setAttribute("role", "dialog");
  const palette = document.createElement("input");
  outside.append(palette);
  document.body.append(outside);
  palette.focus();
  fireEvent.focusIn(palette);
  outside.remove();
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(document.activeElement).toBe(document.body);
});
