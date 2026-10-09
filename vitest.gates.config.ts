// The gate runner's container suite (P0-06): seeded-defect fixtures through real containers.
// Needs Docker; CI runs it in the `gates` job after building the image.
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["gates/**/*.int.test.ts"],
    exclude: [...configDefaults.exclude, "gates/fixtures/**"],
    testTimeout: 600_000,
    hookTimeout: 1_800_000,
    maxConcurrency: 3,
  },
});
