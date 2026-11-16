// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ticket } from "@/lib/api/client";
import { fakeChangeSignal } from "@/lib/workspace-reads/fake-signal";
import { TestReads } from "@/lib/workspace-reads/testing";
import { OpenTicket, useOpenTicket, useTicket } from ".";
import { TestOpenTicket } from "./testing";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);

const ticket = (title: string, overrides: Partial<Ticket> = {}): Ticket => ({
  id: "id-1",
  reference: "T-1",
  title,
  status: "Todo",
  trashed: false,
  body: "",
  project_id: null,
  plan_id: null,
  availability: null,
  tags: [],
  parent: null,
  children: [],
  prerequisites: [],
  ...overrides,
});

/** A call a test resolves by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function Page() {
  const { record, opening } = useOpenTicket();
  return (
    <article aria-busy={opening}>
      <h3>{record.title}</h3>
    </article>
  );
}

beforeEach(() => {
  bridge.invoke.mockReset();
});
afterEach(cleanup);

describe("the gate", () => {
  it("shows the page skeleton until the first read answers, then the page", async () => {
    const first = deferred<Ticket>();
    bridge.invoke.mockReturnValue(first.promise);
    render(
      <TestReads>
        <OpenTicket reference="T-1">
          <Page />
        </OpenTicket>
      </TestReads>,
    );
    expect(screen.getByRole("status", { name: "Loading ticket" })).toBeTruthy();
    expect(screen.queryByRole("heading")).toBeNull();

    await act(async () => first.resolve(ticket("Fresh")));
    expect(await screen.findByRole("heading", { name: "Fresh" })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading ticket" })).toBeNull();
  });

  it("shows a seed at once as opening, then the fresh record", async () => {
    const first = deferred<Ticket>();
    bridge.invoke.mockReturnValue(first.promise);
    render(
      <TestReads>
        <OpenTicket reference="T-1" seed={ticket("Saved copy")}>
          <Page />
        </OpenTicket>
      </TestReads>,
    );
    const page = screen.getByRole("article");
    expect(screen.getByRole("heading", { name: "Saved copy" })).toBeTruthy();
    expect(page.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByRole("status", { name: "Loading ticket" })).toBeNull();
    expect(
      screen.getByText("Loading the latest ticket. Showing its saved copy."),
    ).toBeTruthy();

    await act(async () => first.resolve(ticket("Fresh")));
    expect(await screen.findByRole("heading", { name: "Fresh" })).toBeTruthy();
    expect(screen.getByRole("article").getAttribute("aria-busy")).toBe("false");
    expect(screen.queryByText(/Showing its saved copy/)).toBeNull();
  });

  it("says why the first read failed, with Retry, and opens the page when Retry works", async () => {
    bridge.invoke
      .mockRejectedValueOnce({ code: "failed", message: "disk hiccup" })
      .mockResolvedValue(ticket("Fresh"));
    render(
      <TestReads>
        <OpenTicket reference="T-1" seed={ticket("Saved copy")}>
          <Page />
        </OpenTicket>
      </TestReads>,
    );
    expect(await screen.findByText("Couldn't load T-1")).toBeTruthy();
    expect(screen.queryByRole("heading")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "Fresh" })).toBeTruthy();
    expect(screen.queryByText("Couldn't load T-1")).toBeNull();
  });

  it("reports a Ticket that no longer exists without offering Retry", async () => {
    bridge.invoke.mockRejectedValueOnce({
      code: "not_found",
      message: "T-1 not found",
    });
    render(
      <TestReads>
        <OpenTicket reference="T-1">
          <Page />
        </OpenTicket>
      </TestReads>,
    );
    expect(await screen.findByText("Couldn't load T-1")).toBeTruthy();
    expect(screen.getByText("It was deleted or moved.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(bridge.invoke).toHaveBeenCalledTimes(1);
  });
});

const recordReads = () =>
  bridge.invoke.mock.calls.filter(([command]) => command === "show_ticket");

describe("a hidden Open Ticket", () => {
  it("issues no record reads and shows nothing until it is shown", async () => {
    bridge.invoke.mockResolvedValue(ticket("Fresh"));
    const { rerender } = render(
      <TestReads>
        <OpenTicket reference="T-1" hidden>
          <Page />
        </OpenTicket>
      </TestReads>,
    );
    await act(async () => {});
    expect(recordReads()).toHaveLength(0);
    expect(screen.queryByRole("status")).toBeNull();

    rerender(
      <TestReads>
        <OpenTicket reference="T-1">
          <Page />
        </OpenTicket>
      </TestReads>,
    );
    expect(await screen.findByRole("heading", { name: "Fresh" })).toBeTruthy();
    expect(recordReads()).toHaveLength(1);
  });

  it("keeps its page and reads nothing after a change until it is shown again", async () => {
    const signal = fakeChangeSignal();
    bridge.invoke
      .mockResolvedValueOnce(ticket("First"))
      .mockResolvedValue(ticket("Second"));
    const view = (hidden: boolean) => (
      <TestReads signal={signal}>
        <OpenTicket reference="T-1" hidden={hidden}>
          <Page />
        </OpenTicket>
      </TestReads>
    );
    const { rerender } = render(view(false));
    expect(await screen.findByRole("heading", { name: "First" })).toBeTruthy();

    rerender(view(true));
    act(() => signal.change());
    await act(async () => {});
    expect(recordReads()).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "First" })).toBeTruthy();

    rerender(view(false));
    expect(await screen.findByRole("heading", { name: "Second" })).toBeTruthy();
    expect(recordReads()).toHaveLength(2);
  });
});

describe("the record", () => {
  it("is current until a change, and again once the record is re-read", async () => {
    const signal = fakeChangeSignal();
    const reread = deferred<Ticket>();
    bridge.invoke
      .mockResolvedValueOnce(ticket("First"))
      .mockReturnValueOnce(reread.promise);
    function Probe() {
      const { current } = useOpenTicket();
      return <output>{current ? "current" : "stale"}</output>;
    }
    render(
      <TestReads signal={signal}>
        <OpenTicket reference="T-1">
          <Probe />
        </OpenTicket>
      </TestReads>,
    );
    expect(await screen.findByText("current")).toBeTruthy();

    act(() => signal.change());
    expect(await screen.findByText("stale")).toBeTruthy();

    await act(async () => reread.resolve(ticket("Second")));
    expect(await screen.findByText("current")).toBeTruthy();
  });

  it("shows a Ticket a write returned at once and re-reads once", async () => {
    const reread = deferred<Ticket>();
    bridge.invoke
      .mockResolvedValueOnce(ticket("Before"))
      .mockReturnValueOnce(reread.promise);
    function Editor() {
      const { record, changed } = useOpenTicket();
      return (
        <>
          <h3>{record.title}</h3>
          <button onClick={() => void changed(ticket("Returned"))}>save</button>
        </>
      );
    }
    render(
      <TestReads>
        <OpenTicket reference="T-1">
          <Editor />
        </OpenTicket>
      </TestReads>,
    );
    expect(await screen.findByRole("heading", { name: "Before" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    expect(await screen.findByRole("heading", { name: "Returned" })).toBeTruthy();
    await act(async () => reread.resolve(ticket("After")));
    expect(await screen.findByRole("heading", { name: "After" })).toBeTruthy();
    expect(recordReads()).toHaveLength(2);
  });
});

describe("TestOpenTicket", () => {
  it("opens a given Ticket without reading it", async () => {
    render(
      <TestOpenTicket ticket={ticket("Primed")}>
        <Page />
      </TestOpenTicket>,
    );
    expect(screen.getByRole("heading", { name: "Primed" })).toBeTruthy();
    expect(screen.getByRole("article").getAttribute("aria-busy")).toBe("false");
    await act(async () => {});
    expect(bridge.invoke).not.toHaveBeenCalled();
  });
});

describe("useTicket", () => {
  function Chip({ reference }: { reference: string }) {
    const { value } = useTicket(reference);
    return <span>{value === undefined ? "…" : (value?.title ?? "gone")}</span>;
  }

  it("shares one read between every caller naming the same Ticket", async () => {
    bridge.invoke.mockImplementation(async (command, args) => {
      if (command !== "show_ticket") throw new Error(`unexpected ${command}`);
      const { reference } = args as { reference: string };
      return { ...ticket(`Title of ${reference}`), reference };
    });
    render(
      <TestReads>
        <Chip reference="T-1" />
        <Chip reference="T-1" />
        <Chip reference="T-2" />
      </TestReads>,
    );
    expect(await screen.findAllByText("Title of T-1")).toHaveLength(2);
    expect(await screen.findByText("Title of T-2")).toBeTruthy();
    expect(recordReads().map(([, args]) => args)).toEqual([
      { reference: "T-1" },
      { reference: "T-2" },
    ]);
  });

  it("reads nothing for no reference, and gives null for a Ticket that is gone", async () => {
    bridge.invoke.mockRejectedValueOnce({ code: "not_found", message: "gone" });
    render(
      <TestReads>
        <Chip reference="T-9" />
      </TestReads>,
    );
    expect(await screen.findByText("gone")).toBeTruthy();

    function None() {
      const { value } = useTicket(null);
      return <span>{String(value)}</span>;
    }
    cleanup();
    bridge.invoke.mockClear();
    render(
      <TestReads>
        <None />
      </TestReads>,
    );
    await act(async () => {});
    expect(screen.getByText("undefined")).toBeTruthy();
    expect(bridge.invoke).not.toHaveBeenCalled();
  });
});
