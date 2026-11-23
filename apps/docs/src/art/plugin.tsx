import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import type { Plugin } from "vite";
import { Sprite } from "./world.tsx";

/** Ship the drawing once. SVG use instances inherit the site's theme and print
 * sharply without sending the scene builder, or hundreds of React nodes, to visitors. */
export function workshopArt(): Plugin {
  const svg = renderToStaticMarkup(<Sprite />);
  const digest = createHash("sha256").update(svg).digest("hex").slice(0, 10);
  const fileName = "assets/workshop-" + digest + ".svg";
  const id = "virtual:ticketd-art";
  return {
    name: "ticketd-workshop",
    resolveId(source) {
      if (source === id) return "\0" + id;
    },
    load(source) {
      if (source === "\0" + id)
        return (
          "export default import.meta.env.BASE_URL + " +
          JSON.stringify(fileName)
        );
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName, source: svg });
    },
    configureServer(server) {
      server.middlewares.use(server.config.base + fileName, (_req, res) => {
        res.setHeader("Content-Type", "image/svg+xml");
        res.end(svg);
      });
    },
  };
}
