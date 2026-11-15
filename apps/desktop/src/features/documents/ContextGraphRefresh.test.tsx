// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { client, type ContextGraph as Graph } from "@/lib/api/client";
import { WorkspaceChangeProvider } from "@/lib/workspace-change";
import { ContextGraph } from "./ContextGraph";

vi.mock("@/lib/api/client", () => ({
  client: { contextGraphExpanded: vi.fn() },
}));
vi.mock("./ContextGraphCanvas", () => ({
  // Each card as a button, and the canvas's caption.
  ContextGraphCanvas: ({
    nodes,
    onSelect,
    footnote,
  }: {
    nodes: { id: string; title?: string; label: string }[];
    onSelect: (id: string) => void;
    footnote?: import("react").ReactNode;
  }) => (
    <div>
      Canvas
      {nodes.map((node) => (
        <button key={node.id} onClick={() => onSelect(node.id)}>
          {node.title ?? node.label}
        </button>
      ))}
      <p>{footnote}</p>
    </div>
  ),
}));

const node = (
  id: string,
  label: string,
  kind: "ticket" | "document" = "ticket",
) => ({
  id,
  kind,
  label,
  state: "Todo",
  trashed: false,
  activity_detail: false,
});
const graph = (nodes: ReturnType<typeof node>[]): Graph => ({
  center: nodes[0]!.id,
  nodes,
  edges: nodes.slice(1).map((target) => ({
    source: nodes[0]!.id,
    target: target.id,
    kind: "mention" as const,
    explanation: null,
  })),
  omitted: false,
  omitted_groups: [],
  continuations: [],
  hidden_details: false,
  max_nodes: 200,
  max_edges: 300,
  max_work: 800,
});

test("the newest refresh wins when answers arrive out of order", async () => {
  const resolvers: ((value: Graph) => void)[] = [];
  vi.mocked(client.contextGraphExpanded)
    .mockReset()
    .mockImplementation(
      () => new Promise<Graph>((resolve) => resolvers.push(resolve)),
    );
  const ui = (version: number) => (
    <WorkspaceChangeProvider value={version}>
      <ContextGraph origin="a" onBack={vi.fn()} onOpen={vi.fn()} />
    </WorkspaceChangeProvider>
  );
  const view = render(ui(0));
  view.rerender(ui(1));
  view.rerender(ui(2));
  expect(resolvers).toHaveLength(3);
  // Newest answers first, then the stale ones.
  await act(async () =>
    resolvers[2]!(graph([node("a", "Renamed"), node("b", "B")])),
  );
  await act(async () =>
    resolvers[0]!(graph([node("a", "Old"), node("b", "B")])),
  );
  await act(async () =>
    resolvers[1]!(graph([node("a", "Older"), node("b", "B")])),
  );
  expect(
    screen.getByText("Renamed", { selector: ".cgraph-subject" }),
  ).toBeTruthy();
  expect(screen.queryByText("Old", { selector: ".cgraph-subject" })).toBeNull();
});

test("the map or list choice holds after centring on another item", async () => {
  const many = Array.from({ length: 14 }, (_, i) => node(`n${i}`, `Item ${i}`));
  vi.mocked(client.contextGraphExpanded)
    .mockReset()
    .mockImplementation(async (center) =>
      center === "n1"
        ? graph([many[1]!, many[0]!, ...many.slice(2)])
        : graph(many),
    );
  render(<ContextGraph origin="n0" onBack={vi.fn()} onOpen={vi.fn()} />);
  // The control is there before the graph; wait for the list first.
  await screen.findByRole("heading", { name: "Mentions 13" });
  fireEvent.click(screen.getByRole("radio", { name: "Graph" }));
  expect(screen.getByText("Canvas")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Item 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Center here" }));
  await screen.findByText("Item 1", { selector: ".cgraph-subject" });
  expect(screen.getByText("Canvas")).toBeTruthy();
  expect(
    screen.getByRole("radio", { name: "Graph", checked: true }),
  ).toBeTruthy();
});

test("a very dense neighbourhood stays a list and groups rows by relationship", async () => {
  const items = [
    node("hub", "Hub"),
    ...Array.from({ length: 35 }, (_, i) => node(`t${i}`, `Ticket ${i}`)),
    node("d1", "Doc 1", "document"),
  ];
  vi.mocked(client.contextGraphExpanded)
    .mockReset()
    .mockResolvedValue(graph(items));
  render(<ContextGraph origin="hub" onBack={vi.fn()} onOpen={vi.fn()} />);
  expect(
    await screen.findByRole("heading", { name: "Mentions 36" }),
  ).toBeTruthy();
  expect(screen.queryByText("Canvas")).toBeNull();
  // Graph stays in the control, disabled: the map would be unreadable.
  expect(
    (screen.getByRole("radio", { name: "Graph" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.queryByRole("button", { name: "Ticket 10" })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: /^Show \d+ more Mentions$/ }),
  );
  expect(screen.getByRole("button", { name: "Ticket 10" })).toBeTruthy();
});
test("the scope caption is the canvas's own line, so the canvas never moves", async () => {
  const many = Array.from({ length: 14 }, (_, i) => node(`n${i}`, `Item ${i}`));
  vi.mocked(client.contextGraphExpanded)
    .mockReset()
    .mockResolvedValue(graph(many));
  render(<ContextGraph origin="n0" onBack={vi.fn()} onOpen={vi.fn()} />);
  // The control is there before the graph; wait for the list first.
  await screen.findByRole("heading", { name: "Mentions 13" });
  fireEvent.click(screen.getByRole("radio", { name: "Graph" }));
  expect(screen.getByText("Canvas").querySelector("p")?.textContent).toContain(
    "14 items · 13 connections",
  );
});

test("Back names the item it returns to, and hidden details have one control", async () => {
  vi.mocked(client.contextGraphExpanded)
    .mockReset()
    .mockImplementation(async (center) => ({
      ...(center === "b"
        ? graph([node("b", "B"), node("a", "A")])
        : graph([node("a", "A"), node("b", "B")])),
      hidden_details: true,
    }));
  render(<ContextGraph origin="a" onBack={vi.fn()} onOpen={vi.fn()} />);
  await screen.findByText("A", { selector: ".cgraph-subject" });
  expect(
    screen.queryByRole("button", { name: "Show update details" }),
  ).toBeNull();
  expect(screen.getByText(/Update details hidden/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "B" }));
  fireEvent.click(screen.getByRole("button", { name: "Center here" }));
  await screen.findByText("B", { selector: ".cgraph-subject" });
  expect(screen.getByRole("button", { name: "Back to A" })).toBeTruthy();
});

afterEach(cleanup);
