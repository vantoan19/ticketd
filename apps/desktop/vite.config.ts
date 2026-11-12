import { readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const { version } = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "package.json"), "utf8"),
) as { version: string };

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  clearScreen: false,
  test: {
    // Timeouts only guard against a hang. The default five seconds is too close to how
    // long a whole-App test takes when every file starts at once on a busy machine, and
    // a test that times out keeps running into the ones after it.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    setupFiles: ["./src/test/setup.ts"],
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
