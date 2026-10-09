// Suites that need Docker and the gate image (CI's gates job): the gate runner's seeded-defect
// fixtures (P0-06) and factoryctl end to end with container gates (P0-07).
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["gates/**/*.int.test.ts", "controller/**/*.int.test.ts"],
    exclude: [...configDefaults.exclude, "gates/fixtures/**"],
    testTimeout: 600_000,
    hookTimeout: 1_800_000,
    maxConcurrency: 3,
  },
});
