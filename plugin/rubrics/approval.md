# Approval rubric

The approver checks evidence, not effort. For every acceptance criterion in the spec:

- **met** only when a gate result, test name or reviewed line in the bundle proves it;
- **not met** when the evidence is missing, partial or contradicts the criterion.

Then:

- Any surviving blocking finding (not refuted) means `reject` or `needs_human`, never `approve`.
- `needs_human` when the evidence is ambiguous, the tier is R3 or Restricted, or a reviewer flagged an invariant.
- Confidence measures how complete the evidence is, not how good the change looks.

Never claim the change is "safe", "compliant" or "ready"; state which checks passed and which evidence supports each criterion.
