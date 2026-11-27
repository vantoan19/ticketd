import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chatSnapshotSchema } from "@/features/chats/client";
import {
  askerOf,
  composerPlaceholder,
  requestLabel,
  turnRuns,
  type PendingRequest,
} from "@/features/chats/model";
import { subAgentView } from "@/features/chats/sub-agents";

/**
 * What the Rust host sends while a sub-agent waits for approval after the main agent's turn
 * ended: the views `chat_view.rs` builds from the stored histories of
 * `sub_agent_approval.jsonl` (Claude Code and Codex). The Rust test writes the files
 * (TICKETD_UPDATE_VIEW_FIXTURES=1) and fails if they change without it; this test reads
 * them with the schemas the interface parses real data with.
 */
const sent = (harness: string) =>
  chatSnapshotSchema.parse(
    JSON.parse(
      readFileSync(
        new URL(`./${harness}-sub-agent-approval-view.json`, import.meta.url),
        "utf8",
      ),
    ) as unknown,
  );

describe.each([
  ["claude", "task_b", "Check limiter test coverage", "npm test -- rate-limit"],
  ["codex", "thr_a", "Editor", "touch notes.txt"],
])("the host's view of a %s sub-agent's approval", (harness, id, title, command) => {
  const { chat, items } = sent(harness);
  const request = items.find(
    (item): item is PendingRequest => item.kind === "request",
  );

  it("is the sub-agent's request, pending, with no turn running", () => {
    expect(request).toMatchObject({
      owner: id,
      state: "pending",
      title: "wants to run",
      subject: command,
    });
    expect(chat.activity).toBe("waiting");
    expect(turnRuns(chat)).toBe(false);
    expect(composerPlaceholder(chat, false)).toMatch(/^Message /);
  });

  it("names the sub-agent where the card names the harness", () => {
    if (!request) throw new Error("no request");
    const asker = askerOf(request, chat.sub_agents);
    expect(asker?.title).toBe(title);
    expect(requestLabel(request, undefined, asker?.title)).toBe(
      `${title} ${request.title} ${command}`,
    );
  });

  it("is in the sub-agent's view with its Step, and in no other", () => {
    const view = subAgentView(chat, items, id, Date.now());
    expect(view?.items.map((item) => item.kind)).toEqual([
      "turn",
      "steps",
      "request",
    ]);
    const main = items.filter((item) => !item.owner);
    expect(main.some((item) => item.kind === "request")).toBe(false);
  });
});
