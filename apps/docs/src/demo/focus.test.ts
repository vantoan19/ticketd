// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { focusWorkspaceControl } from "./focus";

it("reveals a ticket in its remounted Board before restoring keyboard focus", () => {
  const workspace = document.createElement("div");
  const board = document.createElement("div");
  const card = document.createElement("button");
  workspace.append(board);
  board.append(card);
  document.body.append(workspace);
  try {
    board.style.overflowY = "auto";
    Object.defineProperties(board, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 240 },
    });
    vi.spyOn(board, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 50, 240, 100),
    );
    vi.spyOn(card, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, 180 - board.scrollTop, 80, 40),
    );

    focusWorkspaceControl(card, workspace);
    expect(document.activeElement).toBe(card);
    expect(card.getBoundingClientRect().bottom).toBeLessThan(
      board.getBoundingClientRect().bottom,
    );
    const position = board.scrollTop;
    focusWorkspaceControl(card, workspace);
    expect(board.scrollTop).toBe(position);
    expect(workspace.scrollTop).toBe(0);
  } finally {
    workspace.remove();
  }
});
