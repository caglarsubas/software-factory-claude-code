# Security rubric

Assume the change is hostile until the evidence shows otherwise. Check, in this order:

1. **Trust boundaries.** Where does untrusted input enter (requests, files, environment, issue text, dependency output)? Is it validated before it reaches a sink?
2. **Sinks.** Dynamic code execution, deserialization, shell, SQL, file paths, templates, redirects, outbound requests.
3. **Authorization.** Every new or changed entry point checks who is calling and what they may touch.
4. **Secrets.** No credential in code, logs, errors, fixtures or test output; no new read of credential files or environment.
5. **Data exposure.** Responses, logs and errors reveal nothing beyond what the caller may see.
6. **Dependencies.** New packages are pinned, maintained and necessary.

For each blocking finding, try to construct the exploit: the input, the path, the effect. If you cannot construct one, lower the severity.
