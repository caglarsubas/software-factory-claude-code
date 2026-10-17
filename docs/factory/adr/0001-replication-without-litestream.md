# ADR 0001: Durability without Litestream

| Field | Value |
|---|---|
| Status | Proposed in the P2-07 PR; accepted when the operator merges it |
| Date | 2026-10-17 |
| Changes | ROADMAP P2-07 ("Litestream for `factory.db`"), the "State loss" row of §8 and the "State" row of §9 |
| Decided by | the operator (2026-10-17), on the evidence below |

## Context

ROADMAP P2-07 names Litestream for replicating `factory.db`. The Phase 2 plan (revision 2) allowed it only if `verify-tools` could check a signature or attestation on its release; otherwise it was to be built from pinned source, or an ADR was to record the exception.

What Litestream's current release offers, checked on 2026-10-17 (v0.5.17, published 2026-08-31):

- **Assets:** a `checksums.txt`, published in the same release as the archives it covers.
- **No signature or provenance:** no sigstore signature, no SLSA provenance, no GPG signature, and no GitHub artifact attestation. The repository's attestations page lists none.
- **What a checksum proves:** a checksum from the same release detects a damaged download, not a tampered release. Every other external tool the factory runs is checked against an independent signature or attestation.

Building it from source was also weighed:

- **Toolchain:** it needs a pinned Go 1.25 toolchain.
- **macOS:** the operator's Mac needs a native darwin arm64 build, since a SQLite file shared into a Docker Desktop container is not safe to replicate from inside the VM.
- **Cost:** that is a second toolchain, a second supply chain and a native build step on the operator's machine, for one function.

Two properties of the factory's own state make a replicator simpler than in the general case Litestream solves:

- **Append-only events:** events are append-only (triggers refuse updates and deletes) and carry a monotonic row id. The leases table is the only state updated in place, and it is small.
- **Content-addressed artifacts:** every artifact a task commits is already named by its sha256 in the event that commits it.

## Decision

`factoryctl` replicates its own state, with no new dependency:

- **Objects.** A write-once, content-addressed object store in `$FACTORY_HOME/objects`.
  - **Committed artifacts:** each one goes into the store before its commit event is written, keyed by the digest the event records.
  - **Task files:** `task.md` and `task.json` go in at creation, named in the `task_created` event.
  - **Run evidence:** each run's evidence (transcripts, manifest, committed files) goes in at the run's end as a tree object, named in an `evidence_stored` event.
  - **Candidate bundle:** the build commits a git bundle of its candidate commits, so an unpushed candidate survives too.

  The event log is the index: every version of every artifact is readable by the digest an event names.
- **Replica.** `factoryctl replica init DIR` points the home at a replica directory outside it, meant for another volume.
  - **Sync:** every writer (a run, a worker, `serve`) syncs it every second, and every command syncs it before it exits.
  - **What a sync copies:** the events after the replica's last row id, under the replica's write lock; the leases table, replaced; and the objects the replica lacks, each checked against its digest.
- **Restore.** `factoryctl restore --source DIR` rebuilds an empty home from a replica.
  - **Database:** restored with SQLite's online backup.
  - **Run directories:** rebuilt from the latest version of each file a task's record names.
  - **Next run:** a restored task rebuilds its clone from the target and its committed candidate bundle, and the outbox finds on GitHub whatever was already pushed or opened.
- **Drills.** `factoryctl drill restore` restores the replica, as it stands, into a scratch home and records RTO, RPO and any file not restored intact. `factoryctl drill kill-switch` halts the factory and records how long until no agent activity is left. Both write under `$FACTORY_HOME/drills/` for G2-6.

## Consequences

- **RPO:** the replica is at most one sync interval (1 second) behind while a writer runs, and in step after each command. G2-6 asks for 1 minute.
- **RTO:** the restore drill measures RTO directly; G2-6 asks for 1 hour.
- **No new dependency or toolchain.** The object store, replica, restore and drills are about 550 lines of TypeScript on `node:sqlite`, tested in `pnpm test`: concurrent syncs from four processes, a restore that reproduces every event and file, and a home lost and restored mid-task that finishes with one push and one PR.
- **Not covered:** the operator's private profile store and the API key file live outside `$FACTORY_HOME`, so the operator backs them up separately. The operator guide says so.
- **Revisit:** if Litestream publishes signed or attested releases, or the factory moves to Postgres (§9: "a second operator or always-on host needs shared state").

## Alternatives considered

| Option | Why not |
|---|---|
| Litestream from its release, pinned by checksum | The checksum comes from the release it would verify, so tampering goes unseen. Every other tool is verified against a signature or attestation. |
| Litestream built from a pinned commit | A Go toolchain pin and a native build on the operator's Mac, for what the append-only store gives almost for free |
| Litestream in a container | SQLite's locks do not hold across Docker Desktop's file sharing; replicating a live database through it risks the replica |
| Periodic full copies only | An RPO of the copy interval, and a full copy of a growing store each time |
