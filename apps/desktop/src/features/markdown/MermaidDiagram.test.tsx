// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MermaidDiagram } from "./MermaidDiagram";
import { MarkdownDocument } from "./MarkdownDocument";

const engine = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock("mermaid", () => ({ default: engine }));

beforeEach(() => {
  engine.initialize.mockReset();
  engine.render.mockReset();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});
afterEach(cleanup);

test("keeps a rendered diagram during unchanged document refreshes", async () => {
  engine.render.mockResolvedValue({
    svg: '<svg viewBox="0 0 100 50"><text>Stable diagram</text></svg>',
  });
  const source = "```mermaid\nflowchart LR\n  A --> B\n```\n";
  const { rerender } = render(<MarkdownDocument source={source} />);
  const diagram = await screen.findByRole("img", { name: "Mermaid diagram" });
  const svg = diagram.querySelector("svg");
  for (let refresh = 0; refresh < 3; refresh++)
    rerender(<MarkdownDocument source={source} />);

  expect(screen.queryByText("Rendering diagram…")).toBeNull();
  expect(screen.getByRole("img", { name: "Mermaid diagram" })).toBe(diagram);
  expect(diagram.querySelector("svg")).toBe(svg);
  expect(screen.queryByRole("button", { name: "Reset zoom" })).toBeNull();
  expect(engine.render).toHaveBeenCalledTimes(1);

  rerender(
    <MarkdownDocument source={source.replace("A --> B", "A --> Updated")} />,
  );
  await waitFor(() =>
    expect(engine.render).toHaveBeenLastCalledWith(
      expect.any(String),
      "flowchart LR\n  A --> Updated\n",
      expect.any(HTMLElement),
    ),
  );
});

test("discards an old diagram when source changes while rendering", async () => {
  let finish: (value: { svg: string }) => void = () => {};
  engine.render
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({ svg: "<svg><text>Newest diagram</text></svg>" });
  const { rerender } = render(<MermaidDiagram source="graph LR; A-->B" />);
  await waitFor(() => expect(engine.render).toHaveBeenCalled());
  rerender(<MermaidDiagram source="graph LR; C-->D" />);
  await act(async () => {
    finish({ svg: "<svg><text>Outdated diagram</text></svg>" });
  });
  await waitFor(() =>
    expect(
      screen.getByRole("img", { name: "Mermaid diagram" }).textContent,
    ).toContain("Newest diagram"),
  );
  expect(screen.queryByText("Outdated diagram")).toBeNull();
});

test("keeps malformed source locally and recovers when the source is corrected", async () => {
  engine.render
    .mockRejectedValueOnce(new Error("Unexpected token"))
    .mockResolvedValue({ svg: "<svg><text>Recovered</text></svg>" });
  const { rerender } = render(<MermaidDiagram source="graph LR; A--" />);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Could not render",
  );
  expect(screen.getByLabelText("Mermaid source").textContent).toBe(
    "graph LR; A--",
  );
  rerender(<MermaidDiagram source="graph LR; A-->B" />);
  await waitFor(() =>
    expect(
      screen.getByRole("img", { name: "Mermaid diagram" }).textContent,
    ).toContain("Recovered"),
  );
  expect(screen.queryByRole("alert")).toBeNull();
});

test("rejects oversized diagrams and document configuration while preserving their source", async () => {
  const source = '%%{init: {"securityLevel":"loose"}}%%\ngraph LR; A-->B';
  const { rerender } = render(<MermaidDiagram source={source} />);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "configuration",
  );
  expect(screen.getByLabelText("Mermaid source").textContent).toBe(source);
  rerender(<MermaidDiagram source={"x".repeat(20001)} />);
  expect((await screen.findByRole("alert")).textContent).toContain("20,000");
  expect(engine.render).not.toHaveBeenCalled();
});

test("keeps rendered SVG inert and removes external image and CSS resources", async () => {
  engine.render.mockResolvedValue({
    svg: '<svg onload="alert(1)"><style>.label{fill:url(https://tracker.example/image)} @import "https://tracker.example/style";</style><foreignObject><div>Unsafe HTML</div></foreignObject><image href="https://tracker.example/image"/><a href="javascript:alert(1)"><text>Unsafe link</text></a><text>Safe label</text><path style="fill:url(https://tracker.example/paint)" /></svg>',
    bindFunctions: vi.fn(),
  });
  render(<MermaidDiagram source="graph LR; A-->B" />);
  const diagram = await screen.findByRole("img", { name: "Mermaid diagram" });
  expect(diagram.textContent).toContain("Safe label");
  expect(diagram.querySelector("foreignObject, image, a, [onload]")).toBeNull();
  expect(diagram.innerHTML).not.toContain("tracker.example");
  expect(engine.initialize).toHaveBeenLastCalledWith(
    expect.objectContaining({
      securityLevel: "strict",
      htmlLabels: false,
      maxEdges: 500,
    }),
  );
});

test("refreshes diagrams for a system theme change with distinct render IDs", async () => {
  let matches = false;
  let changed = () => {};
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      get matches() {
        return matches;
      },
      addEventListener: (_event: string, listener: () => void) => {
        changed = listener;
      },
      removeEventListener: vi.fn(),
    }),
  });
  engine.render.mockImplementation(async (id: string) => ({
    svg: `<svg><text>${id}</text></svg>`,
  }));
  const { container } = render(<MermaidDiagram source="graph LR; A-->B" />);
  await screen.findByRole("img", { name: "Mermaid diagram" });
  const first = container.textContent;
  await act(async () => {
    matches = true;
    changed();
  });
  await waitFor(() =>
    expect(engine.initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: "dark" }),
    ),
  );
  await waitFor(() => expect(container.textContent).not.toBe(first));
  const identifiers = engine.render.mock.calls.map((args) => args[0]);
  expect(new Set(identifiers).size).toBe(identifiers.length);
});

test("offers exact source copy and an expanded keyboard-accessible zoom view without entering editing", async () => {
  engine.render.mockResolvedValue({
    svg: '<svg viewBox="0 0 100 50"><text>Diagram</text></svg>',
  });
  const source = 'graph LR\r\n  A["Xin chào 🌿"] --> B\r\n';
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const edit = vi.fn();
  render(
    <div onClick={edit}>
      <MermaidDiagram source={source} />
    </div>,
  );
  await screen.findByRole("img", { name: "Mermaid diagram" });
  fireEvent.click(screen.getByRole("button", { name: "Source" }));
  expect(screen.getByLabelText("Mermaid source").textContent).toBe(source);
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(source));
  fireEvent.click(screen.getByRole("button", { name: "Expand" }));
  expect(
    screen.getByRole("dialog", { name: "Expanded Mermaid diagram" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  expect(
    screen.getByRole("button", { name: "Reset zoom" }).textContent,
  ).toContain("125%");
  fireEvent.click(screen.getByRole("button", { name: "Reset zoom" }));
  expect(
    screen.getByRole("button", { name: "Reset zoom" }).textContent,
  ).toContain("100%");
  expect(edit).not.toHaveBeenCalled();
});

test("keeps resource-loading image nodes as source without invoking the renderer", async () => {
  const source =
    'flowchart LR\n  A@{ img: "https://tracker.example/image", label: "Remote" }';
  render(<MermaidDiagram source={source} />);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "external resources",
  );
  expect(screen.getByLabelText("Mermaid source").textContent).toBe(source);
  expect(engine.render).not.toHaveBeenCalled();
});

test("a stuck render times out instead of leaving the skeleton, and paints on the next focus", async () => {
  vi.useFakeTimers();
  try {
    engine.render.mockReturnValueOnce(new Promise(() => {}));
    engine.render.mockResolvedValue({
      svg: '<svg viewBox="0 0 100 50"><text>Cart</text></svg>',
    });
    const { container } = render(
      <MermaidDiagram source={"flowchart LR\n  A --> B\n"} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10500);
    });
    expect(container.querySelector(".mermaid-pending")).toBeNull();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(screen.getByRole("img", { name: "Mermaid diagram" })).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});
