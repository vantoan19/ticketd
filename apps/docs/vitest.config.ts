import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Component tests render the landing page directly, without the router build.
export default defineConfig({
  plugins: [react()],
  resolve: { tsconfigPaths: true },
  test: {
    environment: "jsdom",
    testTimeout: 15000,
    include: ["src/**/*.test.tsx"],
  },
});
