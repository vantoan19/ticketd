// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { DocumentNavigation } from "@/features/documents/navigation";
import { PlanDocuments } from "./PlanDocuments";
import type { PlanViewState } from "./usePlanView";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ResizeObserverStub;

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);

test("adds context, designates a spec, and opens its source", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "recent_documents" || command === "search_documents")
      return [{ id: "doc", heading: "Proposal" }];
    return null;
  });
  const run = vi.fn(async (action: () => Promise<unknown>) => {
    await action();
    return true;
  });
  const state: PlanViewState = {
    view: null,
    loadError: "",
    pending: false,
    actionError: "",
    adding: false,
    setAdding: vi.fn(),
    run,
  };
  const plan = {
    id: "plan",
    name: "Plan",
    purpose: "",
    archived: false,
    spec_document_id: null,
  };
  const base = {
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
  const open = vi.fn();
  const rendered = render(
    <DocumentNavigation.Provider value={open}>
      <PlanDocuments view={base} state={state} />
    </DocumentNavigation.Provider>,
  );
  expect(screen.queryByText("Primary spec")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add context" }));
  fireEvent.change(screen.getByLabelText("Search Documents by title"), {
    target: { value: "Prop" },
  });
  fireEvent.click(await screen.findByRole("button", { name: "Proposal" }));
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
  rendered.rerender(
    <DocumentNavigation.Provider value={open}>
      <PlanDocuments
        view={{
          ...base,
          documents: [{ id: "doc", heading: "Proposal", trashed: false }],
        }}
        state={state}
      />
    </DocumentNavigation.Provider>,
  );
  // A single linked Document is the chip even before it is designated.
  expect(
    screen.getByRole("button", { name: "Document: Proposal" }),
  ).toBeTruthy();
  expect(screen.queryByText("1 linked Document")).toBeNull();
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "Actions for Proposal" }),
    { button: 0, ctrlKey: false },
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Set as spec" }));
  await waitFor(() =>
    expect(bridge.invoke).toHaveBeenCalledWith(
      "set_plan_spec",
      expect.objectContaining({ planId: "plan", documentId: "doc" }),
    ),
  );
  rendered.rerender(
    <DocumentNavigation.Provider value={open}>
      <PlanDocuments
        view={{
          ...base,
          plan: { ...plan, spec_document_id: "doc" },
          documents: [{ id: "doc", heading: "Proposal", trashed: false }],
        }}
        state={state}
      />
    </DocumentNavigation.Provider>,
  );
  const chip = screen.getByRole("button", { name: "Spec: Proposal" });
  fireEvent.click(chip);
  expect(open).toHaveBeenCalledWith("doc", "Back to Plan");
});

test("the picker says when every Document is already linked", async () => {
  bridge.invoke.mockImplementation(async (command: string) =>
    command === "recent_documents"
      ? [{ id: "doc", heading: "Proposal" }]
      : null,
  );
  const state = { run: vi.fn(), pending: false } as unknown as PlanViewState;
  const plan = {
    id: "plan",
    name: "Plan",
    purpose: "",
    archived: false,
    spec_document_id: null,
  };
  cleanup();
  render(
    <PlanDocuments
      view={{
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
        documents: [{ id: "doc", heading: "Proposal", trashed: false }],
      }}
      state={state}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add context" }));
  expect(
    await screen.findByText("All Documents are already linked"),
  ).toBeTruthy();
});

const twoDocuments = {
  plan: {
    id: "plan",
    name: "Plan",
    purpose: "",
    archived: false,
    spec_document_id: null,
  },
  members: [],
  counts: {
    todo: 0,
    in_progress: 0,
    in_review: 0,
    done: 0,
    canceled: 0,
    duplicate: 0,
  },
  documents: [
    { id: "a", heading: "First", trashed: false },
    { id: "b", heading: "Second", trashed: false },
  ],
};

test("with several Documents the first stays named and the rest sit behind +N", async () => {
  bridge.invoke.mockResolvedValue([]);
  cleanup();
  render(
    <PlanDocuments
      view={twoDocuments}
      state={{ run: vi.fn(), pending: false } as unknown as PlanViewState}
    />,
  );
  expect(screen.getByRole("button", { name: "Document: First" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Second/ })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "1 more linked Document" }),
  );
  expect(await screen.findByRole("button", { name: "Second" })).toBeTruthy();
});

test("Escape closes the Add context popover", async () => {
  bridge.invoke.mockResolvedValue([]);
  cleanup();
  render(
    <PlanDocuments
      view={twoDocuments}
      state={{ run: vi.fn(), pending: false } as unknown as PlanViewState}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add context" }));
  const search = await screen.findByLabelText("Search Documents by title");
  fireEvent.keyDown(search, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByLabelText("Search Documents by title")).toBeNull(),
  );
});
