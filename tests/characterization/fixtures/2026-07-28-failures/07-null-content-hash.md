---
id: null-content-hash
symptom: |
  A managed production / artifact row persisted with a NULL or empty
  content_hash. The production cannot be content-addressed, the unique-exact
  index silently collapses distinct productions together via COALESCE, and
  downstream formalization resolvers fail closed.
root_cause_class: null-content-hash
evidence: |
  - src/process-modules/persistence/sqlite-managed-production-ledger.ts:177
    declares `content_hash TEXT,` (nullable, no NOT NULL).
  - sqlite-managed-production-ledger.ts:182-186 builds the exact-replay unique
    index with `COALESCE(content_hash, '')` — explicitly tolerating NULL, so
    two productions with NULL hashes are treated as the same exact replay.
  - sqlite-managed-production-ledger.ts:142 and :469 type the row as
    `content_hash: string | null` and propagate the null into the read model.
  - src/saga3/persistence/sqlite-saga3-discovery-runtime.ts:182-184 documents
    the failure mode in a comment: "Without it [project_repository_id]
    artifacts end up with NULL project_repository_id and NULL content_hash,
    and formalization resolvers fail closed." The hash is computed by
    artifactDiskHash which depends on project_repository_id being present.
reproduction: |
  Static:
    `grep -n "content_hash    TEXT\|COALESCE(content_hash" src/process-modules/persistence/sqlite-managed-production-ledger.ts`
    `sed -n '180,186p' src/process-modules/persistence/sqlite-managed-production-ledger.ts`
    `sed -n '182,184p' src/saga3/persistence/sqlite-saga3-discovery-runtime.ts`
  Dynamic: insert a managed_artifact_productions row with content_hash=NULL
  (or accept an artifact whose artifactDiskHash could not be computed) and
  observe the COALESCE index treats it as the empty-string exact key.
expected_after_fix: |
  Every production envelope carries a mandatory, non-null content hash
  computed at production time (NodeProductionEnvelope / ProcessProduct,
  plan §0.6.2/§0.6.3 Wave 3). The schema column becomes NOT NULL and the
  COALESCE collapse is removed. A production without a hash fails closed at
  the contract boundary, not silently at index time.
fixing_waves:
  - "3"
  - "1"
---

# Fixture: null-content-hash

Captured from the 2026-07-28 failure taxonomy (plan §2.2). Task file W00-A6
item 7 names sqlite-*-runtime.ts and Wave 3 as the fixing wave.

## Boundary that is unstable

Content-addressing is optional at the persistence boundary: the hash column is
nullable and the uniqueness index papers over NULL with COALESCE. Two
distinct-but-hashless productions become indistinguishable.

## Why this is a fixture, not a fix

Wave 3 (plan §0.6) makes exact product identity and hashes mandatory in the
durable envelope contract. This fixture pins the current nullable/COALESCE
behavior so the Wave 3 exit gate can prove the hash is NOT NULL by contract.
