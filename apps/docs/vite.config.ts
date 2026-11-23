import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { fumadocsMdx } from "fumadocs-mdx/vite";
import { siteBase } from "./site-base.ts";

import { workshopArt } from "./src/art/plugin.tsx";
import { proofImages } from "./capture/proof-images.ts";
import {
  desktopTokens,
  desktopComponentCss,
} from "./src/art/desktop-tokens.ts";

export default defineConfig({
  base: siteBase,
  plugins: [
    workshopArt(),
    proofImages(),
    desktopTokens(),
    fumadocsMdx({ macro: false }),
    tailwindcss(),
    reactRouter(),
  ],
  // Include the site and desktop UI dependencies in the same optimizer pass.
  // Discovering the desktop imports on a first visit would reload the demo.
  optimizeDeps: {
    include: [
      "class-variance-authority",
      "cn",
      "lucide-react",
      "motion/react",
      "next-themes",
      "radix-ui",
    ],
  },
  server: { watch: { ignored: ["**/build/**"] } },
  css: desktopComponentCss,
  resolve: { tsconfigPaths: true },
});
