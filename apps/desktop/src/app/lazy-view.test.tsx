// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { lazyView } from "./lazy-view";

afterEach(cleanup);

function Greeting({ name }: { name: string }) {
  return <p>Hello {name}</p>;
}

test("a view loads on first render", async () => {
  const View = lazyView(() => Promise.resolve(Greeting));
  render(<View name="Ada" />);
  expect(await screen.findByText("Hello Ada")).toBeTruthy();
});

test("a preloaded view renders at once, without suspending", async () => {
  const View = lazyView(() => Promise.resolve(Greeting));
  await View.preload();
  render(<View name="Ada" />);
  expect(screen.getByText("Hello Ada")).toBeTruthy();
});

test("a view whose module fails to load says so in its place", async () => {
  const View = lazyView<{ name: string }>(() =>
    Promise.reject(new Error("Failed to fetch dynamically imported module")),
  );
  render(<View name="Ada" />);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Couldn't load this view",
  );
});
