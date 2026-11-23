import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// The tour and release-selection contracts are pure and run without a browser.
export default defineConfig({
  plugins: [react()],
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    testTimeout: 15000,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
