// Unit tests: everything except fixture targets and gate fixtures (target code under test) and
// the container suites, which need Docker: the gate image (pnpm test:gates) and the runner image
// (pnpm test:runner).
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "fixtures/**", "gates/fixtures/**", "gates/rules/**", "**/*.int.test.ts", "**/*.runner.test.ts"],
    // Tests that spawn git and node run several times slower under the full suite's load on the
    // operator's Mac than alone; 5 s timed out tests that take about 1 s alone.
    testTimeout: 30_000,
  },
});
