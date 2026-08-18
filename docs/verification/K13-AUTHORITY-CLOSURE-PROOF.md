# K13 — Exact Accepted Head and Obligation Settlement: the authority-correct beta proof

Status: **evidence produced, gate unsigned.** Signing K13 is the architect's
act (the registry test pins `releases.K13.state` to `open` precisely so no
agent can close it bookkeeping-style). This document is the evidence bundle
the architect signs against. Branch `saga4`; base `f3abae43`.

The card: `docs/vision/SAGA-CORE-RENEWAL-PLAN.md` §K13. The brief:
`docs/handoff/STAGE-9-AGENT-BRIEF.md`.

---

## 1. The commit train (card order, red-first)

| # | Commit | What it installed |
|---|--------|-------------------|
| 1 | `81048a2b` | The canonical failing theorem: same-revision drift in ANY extended identity dimension was silently swallowed — 1 pass / 6 fail at the base, every failure "Missing expected exception" |
| 2 | `5ca7279e` | `AcceptedAuthorityHead` extended with the byte-identical identity (acceptance ID, check-plan digest, package fingerprint, production revision, ProductRefs, CAS baseline); schema v15, ONE migration family; identity resolved inside the acceptance transaction from the persisted chain |
| 3 | `16b001e1` | Final-acceptance obligation receipts cite the persisted row digest (`cell-final-acceptance:<sha256>`), not the fabricated `transition-completion:<key>` alias |
| 4 | `99558b12` | route-lifecycle postcondition quantifies over ALL of the source's stage runs (typed empty case); the negative theorem: a bare Workplace status write settles NOTHING |
| 5 | `519fe2c0` | ADR-074 re-certified in-process (repair receipt terminal, staleness) + the REAL crash: engine SIGKILLed mid-provider after the accepted head; recovery observation-authorizes any retry |
| 6 | `5fb12824` | The one-accepted-head-writer ratchet (§27 house style): compiled-tree write ban, frozen prototype surface, single-caller fence — negative-validated on BOTH fences |

Plus one explicitly non-card repair commit: the stale migration-smoke
fixtures (pre-existing red at the base) were aligned with the post-purge
fail-closed contract so the canonical manifest could run at all.

## 2. The invariants, and where each is proven

**Same accepted revision ⇒ byte-identical authority identity.**
`accepted-head-exact-identity.test.mjs` (7/7) — drift in the check-plan
digest, package fingerprint, production revision, ProductRefs (set AND
order), or CAS baseline at the same revision fails closed with
`AUTHORITY_HEAD_IDENTITY_CONFLICT` naming the drifted dimension. The
acceptance id is a deterministic content address (same identity ⇒ same
bytes in any database).

**Accepted head movement is monotonic and CAS-fenced.**
`accepted-head-monotonicity.test.mjs` (3/3) +
`accepted-head-parity-and-race.test.mjs` (3/3, two connections over one
WAL file) — regression fails typed, exactly one identity wins a revision,
duplicate acknowledgement converges without touching `recorded_at`, and a
lost fenced upsert is resolved against the persisted row, never silently
swallowed.

**FinalAcceptance cites the exact effect receipt or the exact no-effect
outcome — never a generic success.** `final-acceptance-identity.test.mjs`
(1/1) + `final-acceptance-completion-receipt.test.mjs` (4/4) + the
`run-effects` postcondition's three-way exact disjunction
(`acceptance-effect-exactly-once.test.mjs` 4/4).

**A generic Workplace status change cannot settle an obligation.**
`route-lifecycle-exact-source.test.mjs` (4/4) and the status-write
theorems in `acceptance-effect-exactly-once.test.mjs`: the exact shape a
generic settlement would rely on (`loop_state='terminal'`,
`terminal_reason='accepted'`) satisfies NO handoff postcondition.

## 3. The ratchet's forbidden set (commit 6)

- **The table**: `factory_accepted_authority_head` — no INSERT/UPDATE/DELETE
  anywhere in the 488-file compiled tree outside the repository module,
  which is identified BY IMPORT, not by name.
- **The surface**: the repository prototype is frozen at eight names — one
  mutator (`record`), its identity helpers (`requireFullIdentity`,
  `assertSameRevisionIdentity`), the idempotent schema ensure
  (`ensureK13IdentityColumns`), three reads.
- **The caller**: `authorityHeadRepo.record(` exists in exactly ONE
  compiled file — the coordinator's `applyVerifiedAcceptance`, reachable
  solely through `CommitAcceptedCandidate`.

Negative validation, both fences: a rogue INSERT temporarily compiled into
`app/product-lifecycle-runtime.js` went RED naming that file; a temporary
`rogueSecondMutator` on the prototype went RED by name; violations removed
→ GREEN (3/3).

## 4. Crash injection is real (commit 5)

`k13-crash-after-accepted-head.test.mjs` (1/1, ~176 s): the engine is
killed with `taskkill /F /T` (verified dead via `process.kill(pid, 0)`)
while an external effect action is CLAIMED mid-provider — after the
accepted head, before any receipt. Recovery waits out BOTH durable leases
(controller 30 s, lifecycle execution 120 s), relaunches, converges exit 0.
Exactly-once in crash form: the killed attempt left no durable result, so
any re-invocation must be OBSERVATION-authorized — the full event lineage
is pinned (every `execution.claimed` after the first originates from
`retry-authorized`, with an observation claim in between). One effect
receipt lineage, one FinalAcceptance, zero stranded executions.

Two environment findings baked in as guards: `execSync` taskkill takes
SINGLE slashes — the `//F` MSYS form silently fails and the engine
SURVIVES, faking the crash (this defeated three diagnostic runs before it
was caught); and the external-effect ledger table is created lazily.

## 5. Verification baseline (this release's tree)

```
npm run build                                   exit 0
node --test "tests/architecture/*.test.mjs"     317 pass / 0 fail   (was 314)
node --test "tests/lifecycle/*.test.mjs"        114 pass / 0 fail
node --test "tests/process-modules/*.test.mjs"  1057 pass / 0 fail  (was 1035)
node --test "tests/infrastructure/*.test.mjs"   314 pass / 0 fail / 12 skip
node --test "tests/factory-e2e/w9-*.test.mjs"   18 pass / 0 fail
node --test tests/worker-prompt-assembly.test.mjs   6 pass / 0 fail
node --test tests/factory-contract/golden-path.test.mjs   1 pass / 0 fail
authority closure suite (tests/architecture/authority-closure-suite.test.mjs)   4/4
migration-smoke trio   18/18 (stale fixtures repaired to the fail-closed contract)
```

Boundary manifest: see §7.

## 6. Superseded decisions and reported residue (the honest list)

1. **The 09687df7 "minimal pointer" audit decision is superseded**: the
   stage-9 brief made the release card the specification; §K13 commit 2
   names the identity columns, and the DDL pin moved with the release
   (6 → 12 columns) in the same commit.
2. **Escalated (not fixed, per the stage-9 escalation rule)**: the
   `transition-completion:<key>` fabricated alias REMAINS for four of the
   five handoff kinds (close-presentation already exact). Same defect
   class as the final-acceptance alias the card replaced; reported for an
   architect decision, not generalized here.
3. **Escalated**: the legacy void-returning effect adapters still fabricate
   `effect-receipt:<effectId>:<candidateSetRef>` refs
   (`post-acceptance-effects.ts:263-271`) — provenance-only, feeds the
   receipt chain; slated for the legacy deletion releases.
4. **Left planned with named missing evidence**: ADR-062 (no behavioural
   suite pins the review-scope policy itself) and ADR-065 (check-plan
   MEMBER identity is only verified as a non-empty plan digest). Eleven
   of the thirteen K13-owned ADRs closed with suite-backed evidence.
5. **The route-lifecycle honesty note**: `factory_stage_runs.process_run_id`
   is UNIQUE (1:1), so the pre-K13 sampled-row read was equivalent for
   every legal shape — the commit-4 quantifier makes the invariant explicit
   rather than fixing a live hole, and the test header says so.
6. **integrated_commit = targetHead** (§9 material-identity question): NOT
   touched by this release; still open for the architect.

## 7. Boundary manifest

`node tools/verification-manifest.mjs --run` executed on the train's final
tree: **sha `2e0ce5004b61`, allGreen = true** — build, factory-ratchet 2/2,
architecture 317/317, factory-contract 87/87, golden-path 1/1,
factory-temporal 31/31, factory-model 3/3, migration-smoke 18/18
(~29 minutes, factory-temporal dominates). The recorded manifest lives at
`docs/verification/verification-manifest.json` (same-SHA discipline; the
commit that carries this document is a docs-only delta from the manifest's
SHA, which `npm run verify:check` accepts). The architect's signing step
re-checks it with `npm run verify:check`.

Two pre-existing red fixture families had to be repaired for the manifest
to run at all (both outside the card train, both committed separately with
their diagnosis): the migration-smoke pair still asserting the REMOVED
in-place ladder (now pins the post-purge fail-closed contract), and the
outcome-routes family still pinning the vocabulary deleted by 3f7ff5d0.

## 8. What I could not prove

- ADR-062 and ADR-065 (see §6.4) — no evidence exists in the tree; the
  entries stay `planned` with notes naming exactly what is missing.
- The Elite-slice production run (M3's "limited production beta") is
  stage 10's question, not this release's; this proof covers the code
  paths, not the factory-under-load behavior.
