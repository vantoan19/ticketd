// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { Switch } from "./switch";

afterEach(cleanup);

const rule = (selector: string) => {
  const css = readFileSync(join(__dirname, "patterns.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  return css.split(selector)[1]?.split("}")[0] ?? "";
};

test("turning it on moves the thumb and the track together", () => {
  render(<Switch aria-label="Chat" />);
  const root = screen.getByRole("switch", { name: "Chat" });
  const thumb = root.querySelector('[data-slot="switch-thumb"]');
  const track = root.querySelector('[data-slot="switch-track"]');
  expect(thumb?.getAttribute("data-state")).toBe("unchecked");
  fireEvent.click(root);
  expect(root.getAttribute("data-state")).toBe("checked");
  expect(thumb?.getAttribute("data-state")).toBe("checked");
  expect(track).not.toBeNull();
});

test("the thumb glides on the glide spring and the track trades colour", () => {
  expect(rule('[data-slot="switch-thumb"]')).toMatch(
    /translate var\(--spring-glide-t\) var\(--spring-glide\)/,
  );
  expect(rule('[data-slot="switch-track"]')).toMatch(
    /background-color var\(--dur-3\) var\(--ease-out\)/,
  );
});
