---
type: regex
pattern: "<pr_body>(?=(?:(?!</pr_body>)[\\s\\S])*AC-1)(?=(?:(?!</pr_body>)[\\s\\S])*AC-2)(?=(?:(?!</pr_body>)[\\s\\S])*R1)(?:(?!</pr_body>)[\\s\\S])*</pr_body>"
weight: 2
---
The PR body names both criteria and the tier, in any order.
