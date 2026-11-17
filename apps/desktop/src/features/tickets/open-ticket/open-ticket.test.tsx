// @vitest-environment jsdom
import { Profiler, useEffect } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ticket } from "@/lib/api/client";
import { fakeChangeSignal } from "@/lib/workspace-reads/fake-signal";
import { useReads } from "@/lib/workspace-reads/reads-context";
import { TestReads } from "@/lib/workspace-reads/testing";
import { OpenTicket, useKnownTicket, useOpenTicket, useTicket } from ".";
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

describe("the page that loads after its skeleton", () => {
  function Fresh() {
    const { record, fresh } = useOpenTicket();
    return <h3 data-fresh={fresh || undefined}>{record.title}</h3>;
  }
  const gate = (props: { seed?: Ticket; hidden?: boolean }) => (
    <TestReads>
      <OpenTicket reference="T-1" {...props}>
        <Fresh />
      </OpenTicket>
    </TestReads>
  );

  it("is fresh once the skeleton gives way, so the document can fade up", async () => {
    const first = deferred<Ticket>();
    bridge.invoke.mockReturnValue(first.promise);
    render(gate({}));
    expect(screen.getByRole("status", { name: "Loading ticket" })).toBeTruthy();
    await act(async () => first.resolve(ticket("Fresh")));
    const heading = await screen.findByRole("heading", { name: "Fresh" });
    expect(heading.hasAttribute("data-fresh")).toBe(true);
  });

  it("is not fresh when a saved copy was shown at once", async () => {
    const first = deferred<Ticket>();
    bridge.invoke.mockReturnValue(first.promise);
    render(gate({ seed: ticket("Saved copy") }));
    await act(async () => first.resolve(ticket("Fresh")));
    const heading = await screen.findByRole("heading", { name: "Fresh" });
    expect(heading.hasAttribute("data-fresh")).toBe(false);
  });

  it("stops being fresh when the page is hidden, so showing it again does not fade it up again", async () => {
    const first = deferred<Ticket>();
    bridge.invoke.mockReturnValue(first.promise);
    const view = render(gate({}));
    await act(async () => first.resolve(ticket("Fresh")));
    await screen.findByRole("heading", { name: "Fresh" });
    view.rerender(gate({ hidden: true }));
    expect(screen.getByRole("heading").hasAttribute("data-fresh")).toBe(false);
    view.rerender(gate({}));
    expect(screen.getByRole("heading").hasAttribute("data-fresh")).toBe(false);
  });
});

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

describe("a Ticket that stops existing", () => {
  it("shows the not-found failure when a re-read says a Ticket that was read is gone", async () => {
    const signal = fakeChangeSignal();
    bridge.invoke
      .mockResolvedValueOnce(ticket("Was here"))
      .mockRejectedValueOnce({ code: "not_found", message: "T-1 not found" });
    render(
      <TestReads signal={signal}>
        <OpenTicket reference="T-1">
          <Page />
        </OpenTicket>
      </TestReads>,
    );
    expect(
      await screen.findByRole("heading", { name: "Was here" }),
    ).toBeTruthy();

    act(() => signal.change());
    expect(await screen.findByText("Couldn't load T-1")).toBeTruthy();
    expect(screen.getByText("It was deleted or moved.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Was here" })).toBeNull();
  });

  it("makes a chip plain when a re-read says the Ticket it names is gone", async () => {
    const signal = fakeChangeSignal();
    bridge.invoke
      .mockResolvedValueOnce(ticket("Was here"))
      .mockRejectedValueOnce({ code: "not_found", message: "T-1 not found" });
    function Chip() {
      const { value } = useTicket("T-1");
      return <span>{value === null ? "plain" : (value?.title ?? "…")}</span>;
    }
    render(
      <TestReads signal={signal}>
        <Chip />
      </TestReads>,
    );
    expect(await screen.findByText("Was here")).toBeTruthy();
    act(() => signal.change());
    expect(await screen.findByText("plain")).toBeTruthy();
  });
});

describe("a Ticket that is gone stays gone", () => {
  it("keeps the not-found state and plain chips when a later re-read fails another way", async () => {
    const signal = fakeChangeSignal();
    bridge.invoke
      .mockResolvedValueOnce(ticket("Was here"))
      .mockRejectedValueOnce({ code: "not_found", message: "T-1 not found" })
      .mockRejectedValueOnce({ code: "workspace_locked", message: "busy" });
    function Chip() {
      const { value } = useTicket("T-1");
      return <span>{value === null ? "plain" : (value?.title ?? "…")}</span>;
    }
    render(
      <TestReads signal={signal}>
        <OpenTicket reference="T-1">
          <Page />
        </OpenTicket>
        <Chip />
      </TestReads>,
    );
    expect(
      await screen.findByRole("heading", { name: "Was here" }),
    ).toBeTruthy();

    act(() => signal.change());
    expect(await screen.findByText("It was deleted or moved.")).toBeTruthy();
    expect(screen.getByText("plain")).toBeTruthy();

    await act(async () => signal.change());
    expect(bridge.invoke).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Couldn't load T-1")).toBeTruthy();
    expect(screen.getByText("It was deleted or moved.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Was here" })).toBeNull();
    expect(screen.getByText("plain")).toBeTruthy();
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

  it("does not re-render a page that never asks whether it is current when a change re-reads an equal record", async () => {
    const signal = fakeChangeSignal();
    const reread = deferred<Ticket>();
    bridge.invoke
      .mockResolvedValueOnce(ticket("Same"))
      .mockReturnValueOnce(reread.promise);
    const commits: string[] = [];
    function Counted() {
      const { record } = useOpenTicket();
      return <h3>{record.title}</h3>;
    }
    render(
      <TestReads signal={signal}>
        <OpenTicket reference="T-1">
          <Profiler id="page" onRender={(id) => commits.push(id)}>
            <Counted />
          </Profiler>
        </OpenTicket>
      </TestReads>,
    );
    await screen.findByRole("heading", { name: "Same" });
    const before = commits.length;

    act(() => signal.change());
    await act(async () => reread.resolve(ticket("Same")));
    expect(bridge.invoke).toHaveBeenCalledTimes(2);
    expect(commits).toHaveLength(before);
  });

  it("holds one observer of the record for every caller of the Open Ticket, whatever they ask", async () => {
    bridge.invoke.mockResolvedValue(ticket("Same"));
    let observers = 0;
    function Caller({ asks }: { asks: boolean }) {
      const state = useOpenTicket();
      useOpenTicket("reminder");
      return <span>{asks ? String(state.current) : state.record.title}</span>;
    }
    function Count() {
      const reads = useReads("test");
      useEffect(() => {
        observers =
          reads.client
            .getQueryCache()
            .find({ queryKey: ["read", "ticket", "T-1"], exact: true })
            ?.getObserversCount() ?? 0;
      });
      return null;
    }
    render(
      <TestReads>
        <OpenTicket reference="T-1">
          <Caller asks />
          <Caller asks={false} />
          <Caller asks={false} />
          <Count />
        </OpenTicket>
      </TestReads>,
    );
    await screen.findByText("true");
    expect(observers).toBe(1);
  });

  it("re-renders only the callers that asked whether the record is current", async () => {
    const signal = fakeChangeSignal();
    const reread = deferred<Ticket>();
    bridge.invoke
      .mockResolvedValueOnce(ticket("Same"))
      .mockReturnValueOnce(reread.promise);
    const commits = { asking: 0, plain: 0 };
    function Asking() {
      const { current } = useOpenTicket();
      return <output>{current ? "current" : "stale"}</output>;
    }
    function Plain() {
      return <h3>{useOpenTicket().record.title}</h3>;
    }
    render(
      <TestReads signal={signal}>
        <OpenTicket reference="T-1">
          <Profiler id="asking" onRender={() => (commits.asking += 1)}>
            <Asking />
          </Profiler>
          <Profiler id="plain" onRender={() => (commits.plain += 1)}>
            <Plain />
          </Profiler>
        </OpenTicket>
      </TestReads>,
    );
    await screen.findByText("current");
    const before = { ...commits };

    act(() => signal.change());
    expect(await screen.findByText("stale")).toBeTruthy();
    await act(async () => reread.resolve(ticket("Same")));
    expect(await screen.findByText("current")).toBeTruthy();
    expect(commits.asking).toBeGreaterThan(before.asking);
    expect(commits.plain).toBe(before.plain);
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
    expect(
      await screen.findByRole("heading", { name: "Returned" }),
    ).toBeTruthy();
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

describe("useKnownTicket", () => {
  it("peeks at the newest copy cached without reading, observing or re-rendering", async () => {
    const signal = fakeChangeSignal();
    bridge.invoke
      .mockResolvedValueOnce(ticket("First"))
      .mockResolvedValue(ticket("Second"));
    let chip = false;
    let commits = 0;
    function Chip() {
      return <span>{useTicket("T-1").value?.title ?? "…"}</span>;
    }
    const { result, rerender } = renderHook(() => useKnownTicket(), {
      wrapper: ({ children }) => (
        <TestReads signal={signal}>
          <Profiler id="peek" onRender={() => (commits += 1)}>
            {children}
          </Profiler>
          {chip && <Chip />}
        </TestReads>
      ),
    });
    expect(result.current("T-1")).toBeUndefined();
    await act(async () => {});
    expect(bridge.invoke).not.toHaveBeenCalled();

    chip = true;
    rerender();
    expect(await screen.findByText("First")).toBeTruthy();
    expect(result.current("T-1")?.title).toBe("First");
    const peeked = commits;
    act(() => signal.change());
    expect(await screen.findByText("Second")).toBeTruthy();
    expect(result.current("T-1")?.title).toBe("Second");
    expect(commits).toBe(peeked);
    expect(result.current("T-2")).toBeUndefined();
    expect(recordReads()).toHaveLength(2);
  });
});
