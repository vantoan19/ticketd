// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  DocumentNavigation,
  PlanNavigation,
} from "@/features/documents/navigation";
import { MarkdownDocument } from "./MarkdownDocument";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: "<svg><text>Diagram</text></svg>" })),
  },
}));
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }),
});
const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);
afterEach(cleanup);

test("renders GFM while keeping executable links and raw HTML inert", () => {
  const { container } = render(
    <MarkdownDocument
      source={
        "# Plan\n\n- [x] Ready\n\n| Key | Value |\n| --- | --- |\n| Name | ticketd |\n\n[Docs](https://example.com) [Unsafe](javascript:alert%281%29)\n\n<script>alert(1)</script><img src=x onerror=alert(1)>"
      }
    />,
  );
  expect(screen.getByRole("heading", { name: "Plan" })).toBeTruthy();
  expect(screen.getByRole("checkbox")).toHaveProperty("checked", true);
  expect(screen.getByRole("table")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Docs" }).getAttribute("href")).toBe(
    "https://example.com",
  );
  expect(screen.queryByRole("link", { name: "Unsafe" })).toBeNull();
  expect(container.querySelector("script, img")).toBeNull();
});

test("labels code blocks and copies their source without changing document content", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(
    <MarkdownDocument source={'```typescript\nconst title = "Ticket";\n```'} />,
  );
  expect(screen.getByText("typescript")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith('const title = "Ticket";\n'),
  );
  expect(screen.getByRole("status").textContent).toContain("Copied");
});

test("routes multiple Mermaid fences to diagrams and copies the exact original CRLF source", async () => {
  const { container } = render(
    <MarkdownDocument
      source={
        '```mermaid\r\ngraph LR\r\n  A["Xin chào 🌿"] --> B\r\n```\r\n\r\n```mermaid\ngraph LR; C-->D\n```'
      }
    />,
  );
  const toggles = screen.getAllByRole("button", { name: "Show source" });
  expect(toggles).toHaveLength(2);
  fireEvent.click(toggles[0]!);
  expect(
    container.querySelector('[aria-label="Mermaid source"]')?.textContent,
  ).toBe('graph LR\r\n  A["Xin chào 🌿"] --> B\r\n');
});

test("highlights known code languages while preserving literal HTML as code", () => {
  const code = 'const label = "<img src=x onerror=alert(1)>";';
  const { container } = render(
    <MarkdownDocument source={"```typescript\n" + code + "\n```"} />,
  );
  expect(container.querySelector("pre code")?.textContent).toBe(code + "\n");
  expect(container.querySelector("pre code span")?.textContent).toBe("const");
  expect(container.querySelector("img")).toBeNull();
});

test("opens a Document link from Markdown", () => {
  const open = vi.fn();
  render(
    <DocumentNavigation.Provider value={open}>
      <MarkdownDocument source="[Context](ticketd://document/doc-1)" />
    </DocumentNavigation.Provider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Context" }));
  expect(open).toHaveBeenCalledWith("doc-1");
});

test("opens a Plan link from Markdown", () => {
  const open = vi.fn();
  render(
    <PlanNavigation.Provider value={open}>
      <MarkdownDocument source="[Plan](ticketd://plan/plan-1)" />
    </PlanNavigation.Provider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Plan" }));
  expect(open).toHaveBeenCalledWith("plan-1");
});

test("marks a linked Document that is in the Trash", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "show_document")
      return {
        id: "doc",
        title: "Old",
        body: "",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        trashed: true,
      };
    throw new Error(`Unexpected ${command}`);
  });
  render(
    <DocumentNavigation.Provider value={vi.fn()}>
      <MarkdownDocument source="See [Old](ticketd://document/doc)" />
    </DocumentNavigation.Provider>,
  );
  expect(
    await screen.findByRole("button", { name: "Old (Trash)" }),
  ).toBeTruthy();
});
