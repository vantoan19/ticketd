import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import { plugin as shadcn } from "@shadcn/lint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/src-tauri/**", "target/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["apps/desktop/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "error",
      "react-refresh/only-export-components": [
        "error",
        { allowConstantExport: true },
      ],
    },
  },
  {
    files: ["apps/chat-bridge-claude/**/*.{ts,mjs}"],
    languageOptions: { globals: globals.node },
    rules: { "@typescript-eslint/no-explicit-any": "error" },
  },
  {
    // Design-system rules (DESIGN.md section 11). Findings that predate them
    // are held in apps/desktop/eslint-suppressions.json, which only shrinks.
    files: ["apps/desktop/src/**/*.tsx"],
    ignores: ["**/*.test.tsx"],
    plugins: { shadcn },
    settings: {
      shadcn: { note: "Follow docs/agents/ui.md and DESIGN.md section 11." },
    },
    rules: {
      "shadcn/no-raw-colors": "error",
      "shadcn/no-arbitrary-values": "error",
      "shadcn/no-restyle": ["error", { allow: ["layout"] }],
      "shadcn/require-static-classes": "error",
    },
  },
);
