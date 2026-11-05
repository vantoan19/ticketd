// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  fireEvent.click(screen.getByText("1 linked Document"));
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
  fireEvent.click(screen.getByRole("button", { name: "Proposal" }));
  expect(open).toHaveBeenCalledWith("doc", "Back to Plan");
});
