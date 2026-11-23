import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { normalizePath, type CSSOptions, type Plugin } from "vite";

const desktopSource = normalizePath(
  fileURLToPath(new URL("../../../desktop/src/", import.meta.url)),
);

// Process the complete stylesheet after Vite resolves its relative imports.
// The display hosts component styles. Document-wide rules belong to the
// native window. :where keeps component specificity intact on older WebKit.
export const desktopComponentCss: CSSOptions = {
  postcss: {
    plugins: [
      {
        postcssPlugin: "ticketd-scope-desktop-styles",
        OnceExit(root) {
          const file = root.source?.input.file;
          if (!file || !normalizePath(file).startsWith(desktopSource)) return;
          root.walkRules((rule) => {
            const parent = rule.parent;
            if (parent?.type === "atrule" && parent.name.endsWith("keyframes"))
              return;
            rule.selectors = rule.selectors.map(
              (selector) => `:where(.desktop-display) ${selector}`,
            );
          });
        },
      },
    ],
  },
};

/** Keep the demonstration on the current desktop palette and type scale without
 * importing window layout, native controls, and resets into the website. */
export function desktopTokens(): Plugin {
  const id = "virtual:desktop-tokens.css";
  const sheet = fileURLToPath(
    new URL("../../../desktop/src/styles.css", import.meta.url),
  );
  return {
    name: "ticketd-desktop-tokens",
    generateBundle() {
      if (this.environment.config.consumer === "client")
        this.emitFile({
          type: "asset",
          fileName: "licenses/Geist-OFL.txt",
          source: readFileSync(
            new URL(
              "../../../desktop/src/assets/fonts/OFL.txt",
              import.meta.url,
            ),
            "utf8",
          ),
        });
    },
    resolveId(source) {
      if (source === id) return "\0" + id;
    },
    load(source) {
      if (source !== "\0" + id) return;
      this.addWatchFile(sheet);
      const result: string[] = [];
      for (const node of postcss.parse(readFileSync(sheet, "utf8")).nodes) {
        if (node.type !== "rule") continue;
        const dark = node.selectors.includes('[data-theme-preview="dark"]');
        if (!dark && !node.selectors.includes("[data-theme-preview]")) continue;
        const declarations = node.nodes.filter(
          (child) => child.type === "decl" && child.prop.startsWith("--"),
        );
        const properties = declarations
          .map((child) => child.toString())
          .join(";");
        result.push(
          (dark ? ".dark " : "") + ".desktop-display{" + properties + "}",
        );
        if (dark)
          result.push(
            "@media(prefers-color-scheme:dark){:root:not(.light) .desktop-display{" +
              properties +
              "}}",
          );
      }
      return result.join("\n");
    },
  };
}
