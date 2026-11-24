import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  agentName,
  demoTickets,
  dependentRef,
  featureRef,
  planCounts,
  planName,
  report,
  specification,
  specTitle,
} from "../src/demo/workspace.ts";

/** The capture caller supplies a newly created, empty directory. The path check
 * also catches a binary that ignores the debug-only workspace override. */
export function seedWorkspace(directory, cli) {
  const database = path.join(directory, "workspace.sqlite3");
  const env = { ...process.env, TICKETD_TEST_WORKSPACE: database };
  function run(...args) {
    return JSON.parse(
      execFileSync(cli, args, { cwd: directory, env, encoding: "utf8" }),
    );
  }
  const location = run("workspace");
  if (path.resolve(location.path) !== database)
    throw new Error("Capture CLI did not select its disposable workspace");
  const plan = run("plan", "create", planName);
  const db = new DatabaseSync(database);
  try {
    // Set a repeatable installation identity before the first Ticket is issued.
    db.prepare(
      "UPDATE device SET code = 'RL', issued = 8 WHERE id = 1 AND issued = 0",
    ).run();
  } finally {
    db.close();
  }
  const spec = run(
    "document",
    "create",
    "--title",
    specTitle,
    "--body",
    specification,
  );
  run(
    "plan",
    "purpose",
    plan.id,
    "Keep the API responsive under request bursts.",
  );
  run("plan", "spec", plan.id, spec.id);
  for (const ticket of demoTickets(0)) {
    const made = run("create", ticket.title, "--plan", plan.id);
    if (made.reference !== ticket.reference)
      throw new Error("Unexpected capture reference " + made.reference);
    run(
      "change",
      ticket.reference,
      "--body",
      ticket.body,
      "--status",
      ticket.status,
    );
  }
  run("set-parent", "T-RL14", "--parent", featureRef);
  run("add-dependency", featureRef, dependentRef);
  run("add-dependency", dependentRef, "T-RL10");
  run("document", "link-ticket", spec.id, featureRef);
  execFileSync(cli, ["write", "-"], {
    cwd: directory,
    env,
    input: JSON.stringify({
      operation: "set_following",
      reference: featureRef,
      following: true,
    }),
  });
  function snapshot() {
    const tickets = run("list", "--latest-update");
    return {
      plan: run("plan", "show", plan.id),
      tickets,
      spec,
      inbox: run("inbox"),
      history: run("history", featureRef),
      activity: run("activity", "list", featureRef),
      evidence: run("evidence", "list", featureRef),
      context: run("context", featureRef, "--relationships"),
      planGraph: run("graph", "--plan", plan.id),
      info: {
        path: path.basename(database),
        format_version: location.format_version,
        size_bytes: statSync(database).size,
        tickets: tickets.length,
        documents: 1,
        active_plans: 1,
        projects: 0,
      },
    };
  }
  const planned = snapshot();
  run("change", featureRef, "--status", "In progress", "--agent", agentName);
  const working = snapshot();
  run(
    "evidence",
    "add",
    featureRef,
    "--kind",
    "branch",
    "--name",
    "Limiter branch",
    "--value",
    "api/rate-limiter",
    "--agent",
    agentName,
  );
  run(
    "evidence",
    "add",
    featureRef,
    "--kind",
    "verification",
    "--name",
    "Boundary tests",
    "--value",
    "Passing",
    "--agent",
    agentName,
  );
  run("activity", "add", featureRef, "--agent", agentName, "--brief", report);
  const reported = snapshot();
  run("change", featureRef, "--status", "In review", "--agent", agentName);
  const review = snapshot();
  run("change", featureRef, "--status", "Done");
  const done = snapshot();
  // A refresh also proves the in-memory demonstration against the actual core.
  const boardEntry = ({ reference, status, availability }) => [
    reference,
    { status, availability },
  ];
  for (const [stage, actual] of [planned, working, review, done].entries()) {
    const demo = demoTickets(stage);
    assert.deepEqual(
      Object.fromEntries(
        actual.tickets.map(({ ticket }) => boardEntry(ticket)),
      ),
      Object.fromEntries(demo.map(boardEntry)),
      "Desktop and demonstration ticket states at step " + (stage + 1),
    );
    assert.deepEqual(actual.plan.counts, planCounts(demo));
    assert.equal(actual.planGraph.total_members, demo.length);
    assert.deepEqual(
      actual.planGraph.nodes.map((node) => node.reference).sort(),
      demo.map((ticket) => ticket.reference).sort(),
      "The captured Plan graph contains every seeded member",
    );
  }
  return { planned, working, reported, review, done };
}
