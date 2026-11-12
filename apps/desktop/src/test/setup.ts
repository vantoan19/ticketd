import { configure } from "@testing-library/react";

// How long `findBy…` and `waitFor` wait is only a guard against a hang. The default one
// second is too short when every test file starts at once on a busy machine.
configure({ asyncUtilTimeout: 30_000 });
