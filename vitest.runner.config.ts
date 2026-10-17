// The runner conformance suite (P2-01): the pinned CLI in the runner image, driven through the
// SDK against a stub model. Needs Docker; CI's runner job runs it on x64 and arm64.
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["controller/**/*.runner.test.ts"],
    exclude: [...configDefaults.exclude, "fixtures/**"],
    testTimeout: 300_000,
    hookTimeout: 1_800_000,
    fileParallelism: false,
  },
});
