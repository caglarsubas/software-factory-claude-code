// Unit tests: everything except fixture targets and gate fixtures (target code under test) and
// the container suites, which need Docker and the gate image (pnpm test:gates).
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "fixtures/**", "gates/fixtures/**", "gates/rules/**", "**/*.int.test.ts"],
  },
});
