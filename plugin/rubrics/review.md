# Review rubric

Applies to every reviewer. Each finding needs all of these, or it is dropped:

1. **Location.** A file and line in the diff, or a line the diff makes reachable.
2. **Failure scenario.** Concrete inputs or state that produce wrong output, a crash, a leak or a broken guarantee. "Could be cleaner" is not a failure scenario.
3. **Fix.** The smallest change that removes the failure.
4. **Confidence.** 0–100: how sure you are that the scenario really happens. Below 50, leave the finding out.

Severity:

| Severity | Use when |
|---|---|
| blocking | the change breaks an acceptance criterion, an invariant, security, or data integrity |
| major | a real defect on a plausible path that the criteria do not cover |
| minor | a defect on an unlikely path, or a missing test for a real path |
| nit | style or naming; never blocks |

Never report: issues outside the diff and its reach, preferences already settled by the repository's linters, or anything you cannot tie to a line.
