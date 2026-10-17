// Unit tests: everything except fixture targets and gate fixtures (target code under test) and
// the container suites, which need Docker: the gate image (pnpm test:gates) and the runner image
// (pnpm test:runner).
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "fixtures/**", "gates/fixtures/**", "gates/rules/**", "**/*.int.test.ts", "**/*.runner.test.ts"],
  },
});
