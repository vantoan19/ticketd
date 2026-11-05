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
  ContextGraphCanvas: () => <div>Canvas</div>,
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
  expect(screen.getByText("Centered on Renamed")).toBeTruthy();
  expect(screen.queryByText("Centered on Old")).toBeNull();
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
  fireEvent.click(await screen.findByRole("button", { name: "Show map" }));
  expect(screen.getByText("Canvas")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Center on Item 1" }));
  await screen.findByText("Centered on Item 1");
  expect(screen.getByText("Canvas")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Show list" })).toBeTruthy();
});

test("a very dense neighbourhood stays a list and groups rows by kind", async () => {
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
    await screen.findByRole("heading", { name: "Tickets 35" }),
  ).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Documents 1" })).toBeTruthy();
  expect(screen.queryByText("Canvas")).toBeNull();
  expect(screen.queryByRole("button", { name: "Show map" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Center on Ticket 10" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show 10 more tickets" }));
  expect(
    screen.getByRole("button", { name: "Center on Ticket 10" }),
  ).toBeTruthy();
});
afterEach(cleanup);
