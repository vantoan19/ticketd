// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Ticket } from "@/lib/api/client";
import { TestReads } from "@/lib/workspace-reads/testing";
import { useOpenTicket, useTicket } from ".";
import { parts, type Part } from "./parts";
import { TestOpenTicket } from "./testing";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => bridge);

// A part as a section would declare it, to prove how parts are served.
declare module "./parts" {
  interface Parts {
    echo: Part<[suffix: string], string>;
  }
}
parts.echo = (record, suffix) => `${record?.title ?? "unknown"}/${suffix}`;

afterEach(cleanup);

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

it("serves a part of the open Ticket to a section, with the record", () => {
  function Section() {
    return <output>{useOpenTicket("echo", "page")}</output>;
  }
  render(
    <TestOpenTicket ticket={ticket}>
      <Section />
    </TestOpenTicket>,
  );
  expect(screen.getByText("Known/page")).toBeTruthy();
});

it("serves the same part by reference to callers above the pages, once the Ticket is known", async () => {
  bridge.invoke.mockResolvedValue(ticket);
  function Header() {
    return <output>{useTicket("T-1", "echo", "header")}</output>;
  }
  render(
    <TestReads>
      <Header />
    </TestReads>,
  );
  expect(screen.getByText("unknown/header")).toBeTruthy();
  expect(await screen.findByText("Known/header")).toBeTruthy();
});
