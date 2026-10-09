// ESLint flat config: strict, type-aware rules for all factory TypeScript.
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  // Fixture targets, gate fixtures and rule tests are target code under test, not factory code.
  globalIgnores(["node_modules/", "coverage/", "dist/", "gates/fixtures/", "gates/rules/", "fixtures/"]),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  { files: ["**/*.js"], extends: [tseslint.configs.disableTypeChecked] },
]);
