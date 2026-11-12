import { configure } from "@testing-library/react";

// How long `findBy…` and `waitFor` wait is only a guard against a hang. The default one
// second is too short when every test file starts at once on a busy machine.
configure({ asyncUtilTimeout: 30_000 });

// jsdom has no matchMedia; pages that follow the system theme read it. Light unless a test stubs it.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
