import { describe, expect, it } from "vitest";
import { BridgeFailure } from "./bridge-failure";
import { describeFailure, sentence } from "./describe-failure";

describe("describeFailure", () => {
  it("says what did not happen in plain words and keeps the raw text for Details", () => {
    const failure = describeFailure(
      {
        code: "workspace_read_only",
        message:
          "workspace database error: attempt to write a readonly database",
      },
      "archive Docs launch",
    );
    expect(failure).toEqual({
      code: "workspace_read_only",
      title: "Couldn't archive Docs launch",
      sentence: "The workspace is read-only, so nothing changed.",
      action: "retry",
      details: "workspace database error: attempt to write a readonly database",
    });
  });

  it("describes a rejected batch operation by its cause", () => {
    const failure = describeFailure(
      new BridgeFailure("batch_operation", "raw", 2, [], "disk_full"),
      "move 3 tickets",
    );
    expect(failure.code).toBe("disk_full");
    expect(failure.sentence).toBe("The disk is full, so nothing changed.");
  });

  it("offers the fix instead of a Retry that cannot succeed", () => {
    expect(
      describeFailure({ code: "too_large", message: "x" }, "attach report.pdf")
        .action,
    ).toBe("change_limit");
  });
});

describe("sentence", () => {
  it("drops internal prefixes and CLI commands and ends with a period", () => {
    expect(
      sentence(
        "Error: document 'D-1' is in trash; restore it with `ticketd document restore D-1` first",
      ),
    ).toBe("Document 'D-1' is in trash; restore it first.");
    expect(sentence("  the Claude bridge stopped during hello ")).toBe(
      "The Claude bridge stopped during hello.",
    );
  });

  it("tells a sign-in that never finished from one that cannot start, and neither as unconfirmed", () => {
    const unconfigured = describeFailure(
      { code: "drive_unconfigured", message: "no configuration" },
      "connect Google Drive",
    );
    expect(unconfigured.sentence).toContain(
      "no Google Drive app configuration",
    );
    expect(unconfigured.action).toBeNull();
    const cancelled = describeFailure(
      { code: "sign_in_cancelled", message: "timed out" },
      "connect Google Drive",
    );
    expect(cancelled.sentence).not.toContain("confirmed");
    expect(cancelled.action).toBe("retry");
  });
});
