// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Ticket } from "@/lib/api/client";
import { TestReads } from "@/lib/workspace-reads/testing";
import { useOpenTicket, useTicket } from ".";
import { TestOpenTicket } from "./testing";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);

const ticket: Ticket = {
  id: "1",
  reference: "T-1",
  title: "Known",
  status: "Todo",
  trashed: false,
  body: "",
  project_id: null,
  plan_id: null,
  availability: null,
  tags: [],
  parent: null,
  children: [],
  prerequisites: [],
};

// A part is read by its Ticket's reference. The bridge answers the reminder
// with a due date made from it, so the tests see which Ticket was read.
async function reply(command: string, args: unknown) {
  if (command === "show_ticket") return ticket;
  if (command === "reminder")
    return `due-${(args as { reference: string }).reference}`;
  return undefined;
}

afterEach(cleanup);

it("serves a part of the open Ticket to a section, with the record", async () => {
  bridge.invoke.mockImplementation(reply);
  function Section() {
    return <output>{useOpenTicket("reminder").value ?? "unread"}</output>;
  }
  render(
    <TestOpenTicket ticket={ticket}>
      <Section />
    </TestOpenTicket>,
  );
  expect(await screen.findByText("due-T-1")).toBeTruthy();
});

it("serves the same part by reference to callers above the pages, once the Ticket is known", async () => {
  bridge.invoke.mockImplementation(reply);
  function Header() {
    return <output>{useTicket("T-1", "reminder").value ?? "unread"}</output>;
  }
  render(
    <TestReads>
      <Header />
    </TestReads>,
  );
  expect(screen.getByText("unread")).toBeTruthy();
  expect(await screen.findByText("due-T-1")).toBeTruthy();
});
