# E2 migration note — content-addressed artifact resolution (groundwork only, TASK 5)

One page, per the stage-12 brief. E2 is approved in principle and NOT for
implementation: it changes capsule identity for every existing capsule, which
needs an explicit invalidation act, not a merge in a wave.

## 1. Which capsules change identity?

Every sealed `WorkplaceProductionSnapshot` capsule that embeds an
**artifactId rowid** in its members or selectors. From the stage-11
measurements:

- **Traces already migrated** (stage-11 tasks 1–2): trace resolution is
  content-addressed via `trace_hash` / the `(source, target_type, target_id,
  link_type)` tuple. Zero traceIds remain in capsule payloads (verified
  six-for-six on the stage-10 corpus). **No trace-side identity changes.**
- **Artifacts are the whole delta**: capsules carry
  `artifact.artifactId` rowids plus per-member `contentDigest` values that
  today derive from the LIVE row (`artifact_update`, a re-dispatched author's
  `(epic,type,code)` upsert, and even `artifact_get`'s disk re-stamp all move
  `content_hash` under a sealed capsule — stage-11 TASK 3 evidence:
  `artifacts.ts:494,526-539`; exposure window extends past run end via the
  lazy certification sweep, `replay-claim-binder.ts:112-185`).
- Scope of the blast radius at the time of writing: the stage-11 corpora
  (`stage11-docking-full` 76 products, `-w12` 32) and every
  `factory_*`-sealed snapshot in the archived run DBs (`stage10-db`,
  `stage11-db`, `stage12-db`). New-resolution capsules are
  **cross-incompatible with old-resolution replays** — a replay executor
  must know which identity regime a capsule belongs to.

## 2. What is the invalidation ceremony?

An explicit, one-time, operator-visible act — the same shape as a schema
migration, but for evidence identity:

1. **Freeze**: declare a cutoff commit; no new seals under the old regime.
2. **Inventory**: enumerate every existing capsule and its artifact-row
   bindings (the harvest corpus manifests give the product-side list).
3. **Re-derive**: compute each capsule's content selectors
   (`type/code/title/path/content_hash` tuple — the artifact analogue of the
   trace tuple) and record a NEW capsule digest alongside the old.
4. **Bless**: a single sanctioned migration writes the new digests with a
   typed marker (`identity-regime: content-v2`) — never a silent rewrite;
   the old digests stay readable for forensics but stop being replay
   authority.
5. **Verify**: replay the golden corpus under the new regime; the stage-11
   corpora double as the acceptance fixture (they must replay GREEN
   unchanged — content is identical, only addressing moves).

## 3. What breaks if done without the ceremony?

- **Silent divergence**: old capsules replayed by a new resolver resolve to
  DIFFERENT material (or none) with no typed error — the stage-10 failure
  shape (`REPLAY_CAPTURE_TRACE_NOT_FOUND`) reborn on the artifact side,
  minus the fail-closed message.
- **Fake freshness**: `artifact_update` re-stamping plus content addressing
  without a cutoff means two capsules with the same old digest but different
  material — replay determinism is gone exactly where §9 demands it.
- **Forensic loss**: re-harvested corpora stop matching recorded digests;
  every bug report written against the old identity becomes unreproducible.

**Recommendation**: schedule E2 as its own stage with the ceremony above as
its TASK 1; do not fold it into any merge wave. (The `verified_by`
trace-link and warrant surfaces are natural companions but orthogonal.)
