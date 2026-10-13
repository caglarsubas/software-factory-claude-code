// Release rules (P1-09): the repository's own changelog holds, and each rule fails on what it guards.
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../controller/src/policy/load.ts";
import { checkRelease, readRelease, releaseNotes, sections } from "./release.ts";

const CHANGELOG = `# Changelog

## [Unreleased]

## [0.2.0] - 2026-10-13

### Added

- Budgets.

## [0.1.0] - 2026-10-09

- Foundation.

[Unreleased]: https://example.invalid/compare/v0.2.0...HEAD
[0.2.0]: https://example.invalid/compare/v0.1.0...v0.2.0
[0.1.0]: https://example.invalid/releases/tag/v0.1.0
`;

describe("release rules", () => {
  it("hold for this repository: plugin.json's version has the newest, dated changelog section", () => {
    expect(checkRelease(readRelease(REPO_ROOT))).toEqual([]);
  });

  it("parse sections and take a version's notes, without the link references", () => {
    expect(sections(CHANGELOG).map((s) => [s.version, s.date])).toEqual([["Unreleased", null], ["0.2.0", "2026-10-13"], ["0.1.0", "2026-10-09"]]);
    expect(releaseNotes(CHANGELOG, "0.2.0")).toBe("### Added\n\n- Budgets.\n");
    expect(releaseNotes(CHANGELOG, "0.1.0")).toBe("- Foundation.\n");
    expect(() => releaseNotes(CHANGELOG, "9.9.9")).toThrow("no section for 9.9.9");
  });

  it("accept a matching tag and refuse every mismatch", () => {
    expect(checkRelease({ changelog: CHANGELOG, pluginVersion: "0.2.0", tag: "v0.2.0" })).toEqual([]);
    const has = (problems: string[], text: string): boolean => problems.some((p) => p.includes(text));
    expect(has(checkRelease({ changelog: CHANGELOG, pluginVersion: "0.2.0", tag: "v0.2.1" }), "does not match")).toBe(true);
    expect(has(checkRelease({ changelog: CHANGELOG, pluginVersion: "0.3.0" }), "no section for plugin.json's version 0.3.0")).toBe(true);
    expect(has(checkRelease({ changelog: CHANGELOG, pluginVersion: "0.1.0" }), "is not the newest release")).toBe(true);
    expect(has(checkRelease({ changelog: CHANGELOG.replace("## [Unreleased]\n", ""), pluginVersion: "0.2.0" }), "[Unreleased]")).toBe(true);
    expect(has(checkRelease({ changelog: CHANGELOG.replace("[0.2.0] - 2026-10-13", "[0.2.0]"), pluginVersion: "0.2.0" }), "has no date")).toBe(true);
    expect(has(checkRelease({ changelog: CHANGELOG.replace("[0.2.0]: https://example.invalid/compare/v0.1.0...v0.2.0\n", ""), pluginVersion: "0.2.0" }), "no link reference")).toBe(true);
    expect(has(checkRelease({ changelog: CHANGELOG.replace("### Added\n\n- Budgets.\n", ""), pluginVersion: "0.2.0" }), "is empty")).toBe(true);
  });
});
