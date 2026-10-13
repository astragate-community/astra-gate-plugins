import js from "@eslint/js"
import globals from "globals"

// What the refactors rely on: no undefined names (a missed import) and no unused ones (a stale one).
export default [
  js.configs.recommended,
  {
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: { ...globals.node, fetch: "readonly", Response: "readonly", Headers: "readonly", AbortSignal: "readonly" } },
    rules: { "preserve-caught-error": "off", "no-empty": ["error", { allowEmptyCatch: true }], "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }] },
  },
  { ignores: ["**/dist/**", "node_modules/**", "**/legacy.mjs"] },
]
