# Dependency rubric

Applies to the dependency reviewer, on top of the review rubric. For each added, removed or changed dependency, check in this order:

1. **Necessity.** The spec needs what it does, and nothing already in the repository or the standard library does it.
2. **Identity.** The name is the package the code means: no typosquat, look-alike, scope swap or a fork under another owner.
3. **Pinning.** Runtime dependencies are pinned to an exact version in the manifest, and the lockfile changes with the manifest and only as the manifest change explains.
4. **Install-time code.** A new install, postinstall or build script, or a native build step, is called out with what it runs.
5. **Source.** Every resolved entry comes from the registry the repository already uses; no git URL, tarball URL or local path.
6. **Known problems.** The dependency audit gate's findings for the new versions, read from the bundle.

Severity: an unpinned runtime dependency, a lockfile that does not match its manifest, a dependency from an unexpected source, or a name that is not the package the code means is **blocking**. A dependency the spec does not need is **major**. Development-only dependencies that are pinned and audited are not findings.
