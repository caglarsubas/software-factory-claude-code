# Repository rulesets

`main.json` protects the default branch: no deletion or force-push, changes only through pull requests, unresolved review threads block merging, and the `ci` check from GitHub Actions (app ID 15368) must pass on an up-to-date branch.

Rulesets are repository settings, so a pull request cannot apply them. The owner imports the file once, and again after every change to it:

1. **Settings → Rules → Rulesets → New ruleset → Import a ruleset**, then choose `main.json`.
2. Review the rules and select **Create**.

Changes to this directory are R3 in the self profile (ROADMAP §3.3): the factory may propose them, and only the owner applies them.
