// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { StatusLineRegion } from "@/components/ui/status-line";
import { DocumentNavigation } from "@/features/documents/navigation";
import type { View } from "@/lib/api/plans";
import { PlanDocumentPicker, PlanDocuments } from "./PlanDocuments";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ResizeObserverStub;

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
// The Document picker's list (cmdk) scrolls the highlighted row into view.
Element.prototype.scrollIntoView ??= () => {};
vi.mock("@tauri-apps/api/core", () => bridge);
afterEach(() => {
  cleanup();
  bridge.invoke.mockReset();
});

const plan = {
  id: "plan",
  name: "Plan",
  purpose: "",
  archived: false,
  spec_document_id: null as string | null,
};
const base: View = {
  plan,
  members: [],
  counts: {
    todo: 0,
    in_progress: 0,
    in_review: 0,
    done: 0,
    canceled: 0,
    duplicate: 0,
  },
  documents: [],
};
const state = {
  pending: false,
  apply: async (change: () => Promise<unknown>) => {
    await change();
  },
};

function Harness({ view, open }: { view: View; open?: () => void }) {
  return (
    <DocumentNavigation.Provider value={open ?? null}>
      <StatusLineRegion>
        <Picker view={view} />
        <PlanDocuments view={view} state={state} />
      </StatusLineRegion>
    </DocumentNavigation.Provider>
  );
}

function Picker({
  view,
  openInitially = false,
}: {
  view: View;
  openInitially?: boolean;
}) {
  const [linking, setLinking] = useState(openInitially);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={anchor} onClick={() => setLinking(true)}>
        Link a Document…
      </button>
      <PlanDocumentPicker
        view={view}
        state={state}
        linking={linking}
        onLinkingChange={setLinking}
        anchor={anchor}
      />
    </>
  );
}

function chooseDocumentAction(name: string, item: string) {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: `Actions for ${name}` }),
    {
      button: 0,
      ctrlKey: false,
    },
  );
  return screen.findByRole("menuitem", { name: item });
}

test("links a Document and offers Undo", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "recent_documents" || command === "search_documents")
      return [{ id: "doc", heading: "Proposal" }];
    return null;
  });
  render(<Harness view={base} />);
  fireEvent.click(screen.getByRole("button", { name: "Link a Document…" }));
  fireEvent.change(
    screen.getByLabelText("Search Documents by title or reference"),
    { target: { value: "Prop" } },
  );
  fireEvent.click(await screen.findByRole("option", { name: /Proposal/ }));
  await waitFor(() =>
    expect(bridge.invoke).toHaveBeenCalledWith(
      "set_plan_document",
      expect.objectContaining({
        planId: "plan",
        documentId: "doc",
        present: true,
      }),
    ),
  );
  expect((await screen.findByRole("status")).textContent).toContain(
    "Linked Proposal to Plan",
  );
});

test("a Document opens, can be set as the spec, and can be removed with Undo", async () => {
  bridge.invoke.mockResolvedValue(null);
  const open = vi.fn();
  const view = {
    ...base,
    documents: [{ id: "doc", heading: "Proposal", trashed: false }],
  };
  const rendered = render(<Harness view={view} open={open} />);
  fireEvent.click(await chooseDocumentAction("Proposal", "Set as spec"));
  await waitFor(() =>
    expect(bridge.invoke).toHaveBeenCalledWith(
      "set_plan_spec",
      expect.objectContaining({ planId: "plan", documentId: "doc" }),
    ),
  );
  rendered.rerender(
    <Harness
      view={{ ...view, plan: { ...plan, spec_document_id: "doc" } }}
      open={open}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Proposal Spec" }));
  expect(open).toHaveBeenCalledWith("doc", "Back to Plan");

  fireEvent.click(await chooseDocumentAction("Proposal", "Remove from Plan"));
  expect(await screen.findByText("Removed Proposal from Plan")).toBeTruthy();
  bridge.invoke.mockClear();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  });
  // Undo links it again and gives back its place as the spec.
  expect(bridge.invoke).toHaveBeenCalledWith(
    "set_plan_document",
    expect.objectContaining({ documentId: "doc", present: true }),
  );
  expect(bridge.invoke).toHaveBeenCalledWith(
    "set_plan_spec",
    expect.objectContaining({ documentId: "doc" }),
  );
});

test("the picker says when every Document is already linked", async () => {
  bridge.invoke.mockImplementation(async (command: string) =>
    command === "recent_documents"
      ? [{ id: "doc", heading: "Proposal" }]
      : null,
  );
  render(
    <Picker
      view={{
        ...base,
        documents: [{ id: "doc", heading: "Proposal", trashed: false }],
      }}
      openInitially
    />,
  );
  expect(
    await screen.findByText("All Documents are already linked"),
  ).toBeTruthy();
});

test("the spec shows first and Show all reveals the remaining Documents", () => {
  const open = vi.fn();
  const documents = Array.from({ length: 8 }, (_, index) => ({
    id: `doc-${index}`,
    heading: `Document ${index + 1}`,
    trashed: false,
  }));
  render(
    <Harness
      view={{
        ...base,
        plan: { ...plan, spec_document_id: "doc-7" },
        documents,
      }}
      open={open}
    />,
  );
  expect(screen.getAllByRole("listitem").map((row) => row.textContent)).toEqual(
    [
      "Document 8Spec",
      "Document 1",
      "Document 2",
      "Document 3",
      "Document 4",
      "Document 5",
    ],
  );
  fireEvent.click(screen.getByRole("button", { name: "Show all 8" }));
  expect(screen.getAllByRole("listitem")).toHaveLength(8);
  fireEvent.click(screen.getByRole("button", { name: "Document 7" }));
  expect(open).toHaveBeenCalledWith("doc-6", "Back to Plan");
});

test("an archived Plan can open its Documents", () => {
  const open = vi.fn();
  render(
    <Harness
      view={{
        ...base,
        plan: { ...plan, archived: true },
        documents: [{ id: "doc", heading: "Proposal", trashed: false }],
      }}
      open={open}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Proposal" }));
  expect(open).toHaveBeenCalledWith("doc", "Back to Plan");
});

test("Escape closes the Link a Document picker", async () => {
  bridge.invoke.mockResolvedValue([]);
  render(<Harness view={base} />);
  fireEvent.click(screen.getByRole("button", { name: "Link a Document…" }));
  const search = await screen.findByLabelText(
    "Search Documents by title or reference",
  );
  fireEvent.keyDown(search, { key: "Escape" });
  await waitFor(() =>
    expect(
      screen.queryByLabelText("Search Documents by title or reference"),
    ).toBeNull(),
  );
});
