// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
nafterEach(cleanup);

it("lends the card look to the element that carries the landmark", () => {
  render(
    <Card asChild>
      <section aria-labelledby="t">
        <CardHeader>
          <h2 id="t">Connection</h2>
        </CardHeader>
        <CardBody>Connected</CardBody>
        <CardFooter>Read-only</CardFooter>
      </section>
    </Card>,
  );
  const card = screen.getByRole("region", { name: "Connection" });
  expect(card).toHaveAttribute("data-slot", "card");
  expect(card).toContainElement(screen.getByText("Connected"));
  expect(card).toContainElement(screen.getByText("Read-only"));
});
