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

describe("a message written for people", () => {
  const refusal = {
    code: "failed",
    message:
      "sync storage: storage: the bucket b does not exist; check the name",
  };

  it("stays out of the headline unless the caller knows the text is its own", () => {
    expect(describeFailure(refusal, "read the bucket").sentence).toBe(
      "The result couldn't be confirmed. Check the saved state before trying again.",
    );
  });

  it("is the sentence when the caller says so, with the raw text kept for Details", () => {
    const failure = describeFailure(refusal, "read the bucket", {
      readable: true,
    });
    expect(failure.sentence).toBe(
      "The bucket b does not exist; check the name.",
    );
    expect(failure.details).toBe(refusal.message);
  });

  it("is also the sentence of a not found failure the caller words itself, and offers another", () => {
    const failure = describeFailure(
      { code: "not_found", message: "sync storage: the bucket b is missing" },
      "read the bucket",
      { readable: true },
    );
    expect(failure.sentence).toBe("The bucket b is missing.");
    expect(failure.action).toBe("choose_another");
    expect(
      describeFailure({ code: "not_found", message: "x" }, "read the bucket")
        .sentence,
    ).toBe("It was deleted or moved.");
  });

  it("never replaces what a classified failure already says", () => {
    expect(
      describeFailure({ code: "offline", message: "dns" }, "read the bucket", {
        readable: true,
      }).sentence,
    ).toBe("ticketd can't reach the service. Check the connection.");
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
