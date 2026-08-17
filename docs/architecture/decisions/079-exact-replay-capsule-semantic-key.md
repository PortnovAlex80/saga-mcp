# ADR-079: Exact replay capsule semantic key

- **Status:** Accepted
- **Date:** 2026-08-17
- **Supersedes:** newest-wins capsule/run-history selection as replay authority
- **Program:** Saga Core Renewal, release K8 (see `docs/vision/SAGA-CORE-RENEWAL-PLAN.md`)

---

## Context

Replay lets a later execution of semantically identical work reuse a
certified accepted result instead of re-executing. The 2026-08-16
conformance audits recorded the binder as newest-wins; the ADR-053 Phase 7
replay cutover then rebuilt the claim side on an exact semantic key
(`replay-key-material.ts`, `replay-capsule-selection.ts`). What was never
done is the DECISION record: which coordinates constitute replay identity,
what transitivity makes the key sufficient, which run-history reads remain
chronological and on what legal basis, and which newest-wins sites are
still live defects. K8 audits and closes exactly that.

Audit findings at K8 entry (worktree `dc1dcf39`):

1. **Claim binding is already exact-semantic.** `bindReplayToClaim`
   resolves a strict key, looks up ALL capsules for
   `WHERE project_id=? AND replay_key=?` (no ORDER BY, no LIMIT), and
   selects: zero → typed miss; one → hit; equal payload hashes →
   deterministic alias (lexicographic `capsule_ref`); divergent payload
   hashes → `REPLAY_KEY_PAYLOAD_CONFLICT` fail-closed.
2. **Three live newest-wins defects** where an invariant-uniqueness that
   the reader silently assumes is NOT schema-enforced: the paused
   protocol-run pick, the active/exhausted recovery-case pick, and the
   process outcome-certificate pick (`ORDER BY id DESC LIMIT 1` each).
   Two rows matching the predicate would be resolved by silently picking
   the newer — the exact failure class this ADR forbids.
3. **One emulated exact read**: the execution-context assembler fetches
   `readLatest(processRunId, nodeId)` and uses it ONLY when
   `latestNodeRun.attempt === attempt` — an exact
   `(processRunId, nodeId, attempt)` probe done through a newest-wins
   fetch plus a guard. The exact reader `readByExactCursor` (backed by a
   UNIQUE index) already exists beside it.
4. **Legal frontier reads** (chronological over run-scoped history with an
   exact scope key and a structural ordinal): crash-resume cursors
   (`readLastCompleted(processRunId)` over the linear node chain), open
   protocol-step attempt maxima, recovery last-attempt, order-run chain
   leaf by `ordinal DESC`, boundary stage runs by `attempt DESC`
   (same family K7 reclassified in the carry-forward), and the CGAD P18
   node-scope submission frontier.

## Decision

### 1. Replay identity is the semantic key — and nothing else

A replay capsule is identified by:

```
ReplayKey = SHA-256({
  projectId,                 // durable project identity
  moduleRef, nodeId,         // producing module + flow node
  productionCellId, workKey, // producing cell + work item
  role,                      // 'author' | 'reviewer'
  packageDigest,             // ADR-077 runtime package fingerprint
  semanticInputDigest,       // frozen cross-run input identity
  subjectProductionDigest,   // reviewer: authority-accepted author members
})                           // author: null
```

Sufficiency is transitive, not incidental:

- **packageDigest** (ADR-077 `computeRuntimePackageDigest(stampedManifest,
  resources)`) freezes the stamped module manifest — including check
  plans and the module contract — plus every resource byte. A changed
  check plan, product contract, or handler implementation changes the
  digest, therefore the key.
- **semanticInputDigest** is the producer-frozen cross-run input identity:
  it embeds the upstream product identities (and thereby the acceptance
  baseline they were accepted under). Run-scoped provenance hashes are
  deliberately NOT accepted (`replay-key-material.ts` returns null —
  replay is not allowed on a run-scoped key).
- **subjectProductionDigest** binds a reviewer's replay to its exact
  subject: the members of the authority-accepted author CandidateSet,
  resolved through `factory_accepted_authority_head` (exact pointer,
  ADR-053 C1), each mapped to its stable semantic digest.

No time, row id, attempt count, lifecycle ordinal, or "newest" flag
participates in the key.

### 2. Lookup semantics: zero / one / alias / conflict — never row order

For a resolved key the capsule lookup MUST fetch the full candidate set
by `replay_key` equality and then:

- **zero** → typed miss: the execution proceeds on its selected inference
  route; replay changed nothing;
- **one** → exact hit; freeze `capsule_ref` + `payload_hash`;
- **several, identical payload hashes** → aliases of one semantic result;
  pick deterministically (lexicographic `capsule_ref`) — the choice is
  observable only as a name;
- **several, divergent payload hashes** → invariant violation:
  `REPLAY_KEY_PAYLOAD_CONFLICT`, fail closed. Never resolve by recency.

Ineligibility (current-gate rejection or failed replay execution in the
same workplace) is DERIVED from durable evidence, never from row order,
and downgrades the outcome to a typed miss.

### 3. Model choice is orthogonal to replay

Replay binds material identity only. It MUST NOT select or mutate
`executor_kind`, model route, or any launch mode; a miss leaves the
selected route untouched (K8 commit 6 pins this with a test).

### 4. Run-history chronology: classified, and the defects cut

Chronology remains legal ONLY as a frontier read: a maximum over a
structural ordinal (attempt / ordinal) or a linear-chain cursor, scoped by
an exact run identity, where the ordering expresses "the current position
of THIS run's history" — never a choice between material subjects. The
K8-owned recency surface resolves as:

- **CUT (defects)**: paused-protocol-run, recovery-case, and
  outcome-certificate picks become fail-closed uniqueness reads (fetch
  the full predicate set; more than one row is an invariant violation).
  The assembler's guarded `readLatest` becomes a direct
  `readByExactCursor(processRunId, nodeId, attempt)` probe;
  `readLatest`/`readLatestV2` are deleted when callerless.
- **KEPT (legal frontier)**: `readLastCompleted`(/V2), open-attempt
  maxima, recovery last-attempt, order-leaf `ordinal DESC`, boundary
  `attempt DESC` traversals, P18 node-scope submission frontier — each
  reclassified with rationale in the classification map
  (`tests/architecture/authority-recency-classification.test.mjs`),
  which K8 updates in the same commit as any cut.

## Consequences

- The N/N-1/N-2 capsule matrix (three lifecycle histories under one
  epic) becomes a regression theorem: the binder resolves the exact
  semantic capsule for each lifecycle's work; cross-lifecycle equality
  of the key is CORRECT reuse (same semantic work), never
  contamination; subject divergence produces different keys.
- Deleting the emulated/unguarded newest-wins readers removes the last
  paths where a duplicated row could silently shift authority to the
  newer copy.
- The exit ratchet: no replay authority lookup orders candidate capsules
  by time, row id, or newest status; the classification map is the
  machine-checkable record of what remains chronological and why.
