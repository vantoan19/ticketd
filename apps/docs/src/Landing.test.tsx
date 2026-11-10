import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import Landing from "./Landing";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("running a machine updates its command, app caption and status together", () => {
  render(<Landing autoplay={false} motion="reduce" />);
  fireEvent.click(
    within(
      screen.getByRole("group", { name: "Machines on the line" }),
    ).getByRole("button", { name: /02.*Plan.*plan create/ }),
  );
  expect(
    screen.getByText('ticketd plan create "Login hardening" | jq -r .id'),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "An active Plan with the spec attached and no tickets yet.",
    ),
  ).toBeTruthy();
  expect(screen.getByText("idle · 02 plan")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "you, in the app" }));
  expect(screen.getByText(/# In the app: Plans/)).toBeTruthy();
  expect(
    screen.queryByText('ticketd plan create "Login hardening" | jq -r .id'),
  ).toBeNull();
});

test("system theme is the default and switching themes preserves the selected machine", () => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("dark"),
    addEventListener() {},
    removeEventListener() {},
  }));
  render(<Landing autoplay={false} motion="reduce" />);
  expect(
    screen
      .getByRole("button", { name: "Dark theme" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  fireEvent.click(
    within(
      screen.getByRole("group", { name: "Machines on the line" }),
    ).getByRole("button", { name: /02.*Plan/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Light theme" }));
  expect(
    screen
      .getByRole("button", { name: "Light theme" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(
    screen.getByText(
      "An active Plan with the spec attached and no tickets yet.",
    ),
  ).toBeTruthy();
});

test("Done and unhooking free waiting tickets; restoring In review blocks again", () => {
  render(<Landing autoplay={false} motion="reduce" />);
  expect(screen.getByText("6 ready · 3 blocked")).toBeTruthy();
  fireEvent.click(screen.getByRole("switch", { name: "T-9 Done" }));
  expect(screen.getByText("7 ready · 2 blocked")).toBeTruthy();
  expect(
    screen.getByText("ticketd change T-9 --status Done | jq -r .status"),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("switch", { name: "T-9 Done" }));
  expect(screen.getByText("6 ready · 3 blocked")).toBeTruthy();
  expect(
    screen.getByText('ticketd change T-9 --status "In review" | jq -r .status'),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Unhook T-13 from T-12" }),
  );
  expect(screen.getByText("7 ready · 2 blocked")).toBeTruthy();
  expect(
    screen.getByText(
      "ticketd remove-dependency T-12 T-13 | jq -r .availability",
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Agent asks for work/ }));
  expect(
    screen.getByText("Your agent gets T-14, the first Ready ticket."),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Chain T-13 to T-12" }));
  expect(screen.getByText("6 ready · 3 blocked")).toBeTruthy();
});

test("keyboard knobs change the monitor channel, moment, Inbox and status together", () => {
  render(<Landing autoplay={false} motion="reduce" />);
  fireEvent.keyDown(screen.getByRole("slider", { name: "Channel" }), {
    key: "End",
  });
  fireEvent.keyDown(
    screen.getByRole("slider", { name: "Moment in the shift" }),
    { key: "ArrowRight" },
  );
  fireEvent.keyDown(
    screen.getByRole("slider", { name: "Moment in the shift" }),
    { key: "ArrowRight" },
  );
  expect(
    screen
      .getByRole("slider", { name: "Channel" })
      .getAttribute("aria-valuetext"),
  ).toBe("Inbox");
  expect(
    screen.getByText("The Inbox has two entries for T-12, from coding-agent."),
  ).toBeTruthy();
  expect(screen.getByText("replay · 00:24 · ch5 inbox")).toBeTruthy();
  fireEvent.keyDown(
    screen.getByRole("slider", { name: "Moment in the shift" }),
    { key: "Home" },
  );
  expect(screen.getByText("The Inbox is empty.")).toBeTruthy();
});

test("context scopes change the command, JSON and highlighted app caption together", () => {
  render(<Landing autoplay={false} motion="reduce" />);
  fireEvent.click(
    within(
      screen.getByRole("group", { name: "Parts to attach to T-12" }),
    ).getByRole("switch", { name: /Updates/ }),
  );
  expect(
    screen.getAllByText(
      /ticketd context T-12 --documents --activities --latest-update --evidence/,
    ).length,
  ).toBeGreaterThan(0);
  expect(screen.getByText('"updates": [')).toBeTruthy();
  expect(
    screen.getByText("Activity: both updates from coding-agent."),
  ).toBeTruthy();
  fireEvent.click(
    within(
      screen.getByRole("group", { name: "Parts to attach to T-12" }),
    ).getByRole("switch", { name: /Updates/ }),
  );
  expect(screen.queryByText('"updates": [')).toBeNull();
});

test("dock bays show recorded output and packing slips, with no app screen for Drive", () => {
  const { container } = render(<Landing autoplay={false} motion="reduce" />);
  const bays = within(screen.getByRole("group", { name: "Bays" }));
  fireEvent.click(bays.getByRole("button", { name: /Publish out/ }));
  expect(
    screen.getByText(/ticketd source publish T-14 --preview/),
  ).toBeTruthy();
  expect(screen.getByText("T-14 → acme/web-app")).toBeTruthy();
  expect(container.querySelector("#dock .app")).not.toBeNull();
  fireEvent.click(bays.getByRole("button", { name: /Google Drive/ }));
  expect(
    screen.getByText("# not in a release yet, so there’s no command to run"),
  ).toBeTruthy();
  expect(container.querySelector("#dock .app")).toBeNull();
});

test("reduced motion presents the completed figures without waiting for animation", () => {
  render(<Landing motion="reduce" />);
  expect(screen.getByText("line done · T-12 in progress")).toBeTruthy();
  expect(
    screen
      .getByRole("slider", { name: "Moment in the shift" })
      .getAttribute("aria-valuenow"),
  ).toBe("3");
  expect(screen.getByText("bay 01 open · github in")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Play it again" })).toBeTruthy();
});

test("copy preserves command continuations and the two Get started links use the install guide", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(<Landing autoplay={false} motion="reduce" />);
  fireEvent.click(
    within(
      screen.getByRole("group", { name: "Machines on the line" }),
    ).getByRole("button", { name: /01.*Spec/ }),
  );
  const line = within(
    screen.getByRole("region", { name: /Every machine on the line/ }),
  );
  await act(async () => {
    fireEvent.click(line.getByRole("button", { name: "Copy this command" }));
  });
  expect(writeText).toHaveBeenCalledWith(
    'ticketd document create --title "Login hardening spec" \\\n    --body-file spec.md | jq -r .id',
  );
  expect(line.getByText("copied")).toBeTruthy();
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Copy ticketd --help" }),
    );
  });
  expect(writeText).toHaveBeenLastCalledWith("ticketd --help");
  const starts = screen.getAllByRole("link", { name: "Get started" });
  expect(starts).toHaveLength(2);
  for (const link of starts)
    expect(link.getAttribute("href")).toBe(
      "https://github.com/vantoan19/ticketd/blob/main/docs/install.md",
    );
});

test("replaying the hero cancels the previous action's pending end state", () => {
  vi.useFakeTimers();
  render(<Landing autoplay={false} />);
  fireEvent.click(
    screen.getByRole("button", { name: /^Make a ticket context/ }),
  );
  act(() => vi.advanceTimersByTime(1000));
  fireEvent.click(
    screen.getByRole("button", { name: /^Read a ticket ticket/ }),
  );
  act(() => vi.advanceTimersByTime(2400));
  expect(screen.getByText("reading T-12 for the next session…")).toBeTruthy();
  act(() => vi.advanceTimersByTime(1500));
  expect(
    screen.getByText("context out: status, notes, latest update"),
  ).toBeTruthy();
});

test("a denied clipboard reports failure instead of claiming the command was copied", async () => {
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText: () => Promise.reject(new Error("Clipboard denied")),
    },
  });
  render(<Landing autoplay={false} motion="reduce" />);
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Copy ticketd --help" }),
    );
  });
  expect(
    screen.getByRole("button", { name: "Copy failed — select ticketd --help" }),
  ).toBeTruthy();
  expect(screen.queryByText("Copied ticketd --help")).toBeNull();
});
