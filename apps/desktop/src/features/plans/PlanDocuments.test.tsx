// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { StatusLineRegion } from "@/components/ui/status-line";
import { DocumentNavigation } from "@/features/documents/navigation";
import type { View } from "@/lib/api/plans";
import { PlanDocuments } from "./PlanDocuments";

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
  const [linking, setLinking] = useState(false);
  return (
    <DocumentNavigation.Provider value={open ?? null}>
      <StatusLineRegion>
        <PlanDocuments
          view={view}
          state={state}
          linking={linking}
          onLinkingChange={setLinking}
        />
      </StatusLineRegion>
    </DocumentNavigation.Provider>
  );
}

function chooseFromChip(name: string, item: string) {
  fireEvent.pointerDown(screen.getByRole("button", { name }), {
    button: 0,
    ctrlKey: false,
  });
  return screen.findByRole("menuitem", { name: item });
}

test("links a Document from the context line while none is linked", async () => {
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

test("the chip's menu opens, sets the spec, and removes with Undo", async () => {
  bridge.invoke.mockResolvedValue(null);
  const open = vi.fn();
  const view = {
    ...base,
    documents: [{ id: "doc", heading: "Proposal", trashed: false }],
  };
  const rendered = render(<Harness view={view} open={open} />);
  // A single linked Document is the chip even before it is designated.
  fireEvent.click(await chooseFromChip("Document: Proposal", "Set as spec"));
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
  fireEvent.click(await chooseFromChip("Spec: Proposal", "Open"));
  expect(open).toHaveBeenCalledWith("doc", "Back to Plan");

  fireEvent.click(await chooseFromChip("Spec: Proposal", "Remove from Plan"));
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
  function Open() {
    return (
      <PlanDocuments
        view={{
          ...base,
          documents: [{ id: "doc", heading: "Proposal", trashed: false }],
        }}
        state={state}
        linking
        onLinkingChange={() => {}}
      />
    );
  }
  render(<Open />);
  expect(
    await screen.findByText("All Documents are already linked"),
  ).toBeTruthy();
});

test("with several Documents the first stays named and the rest sit behind +N", async () => {
  bridge.invoke.mockResolvedValue([]);
  render(
    <Harness
      view={{
        ...base,
        documents: [
          { id: "a", heading: "First", trashed: false },
          { id: "b", heading: "Second", trashed: false },
        ],
      }}
    />,
  );
  expect(screen.getByRole("button", { name: "Document: First" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Second/ })).toBeNull();
  // Once a Document is linked, linking another lives in the Plan's menu.
  expect(screen.queryByRole("button", { name: "Link a Document…" })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "1 more linked Document" }),
  );
  expect(await screen.findByRole("button", { name: "Second" })).toBeTruthy();
});

test("an archived Plan's chip only opens the Document", () => {
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
  fireEvent.click(screen.getByRole("button", { name: "Document: Proposal" }));
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
