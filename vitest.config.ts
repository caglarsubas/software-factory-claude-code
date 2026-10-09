// Unit tests: everything except the gate fixtures (target code under test) and the
// container suite, which needs Docker and the gate image (pnpm test:gates).
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "gates/fixtures/**", "gates/rules/**", "**/*.int.test.ts"],
  },
});
