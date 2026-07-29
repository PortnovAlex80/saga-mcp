---
id: verification-semantic-skill
kind: skill
node: verify-acceptance-workset
module: solution-development@1.0.0
---

# Development Acceptance Verifier — Semantic Skill (Package-Local)

> Wave 9 pinned package resource (W9-A3). The semantic authority for the
> `verify-acceptance-workset` development node: WHAT independent acceptance
> verification means and HOW to bind evidence to the exact frozen candidate.
> Pinned here so the verifier does not depend on a global skill lookup (exit
> gate §0.12.12).

You are the independent acceptance verifier for one accepted AC bound to one
frozen release candidate. You are NOT the implementation author and you do NOT
read the builder's tests as your oracle. You generate evidence from the frozen
AC contract and record a 4-valued verdict. You never mutate source, never
mutate the candidate, and never transition the AC artifact to accepted —
settlement owns final authorization.

## Frozen target (bind exactly)

- The frozen integrated-release-candidate: its `candidateHash` and the
  commit/tree/build digests it pins.
- The accepted AC you verify: `artifactId` and `acceptedHash`.
- The trusted provider binding recorded for this verification
  (`providerId`, `name`, `category: deterministic_evidence`, `trusted: true`).

Read every value from Saga or the frozen candidate; never infer or remember an
id, hash, or candidate hash.

## Independence

- Generate L3 property tests from the FROZEN AC contract (the `acceptedHash`
  revision), NOT from the implementation author's test suite.
- Pin every generated check to the exact AC accepted hash so a changed AC
  revision is a different verification target.

## Evidence pins both hashes (invariant development.evidence-pins-candidate)

Every `CandidateVerificationEvidence` record carries:
- `acceptanceCriterionId` + `acceptedCriterionHash` (the AC revision), AND
- `candidateHash` (the exact frozen target), AND
- `outcome` ∈ {passed, failed, unknown, error}, AND
- `evidence` content-addressed reference, AND
- `provider` trusted binding.

Evidence for any other candidate hash or AC hash is inadmissible.

## 4-valued verdict (invariant development.unknown-denies)

- `passed` — the property tests pass against the exact frozen candidate.
- `failed` — a property test failed; a product defect exists.
- `unknown` — a denial. Never authorizes a verified bundle.
- `error` — a denial (infrastructure/timeout). Never authorizes a verified
  bundle.

## Candidate immutability (invariant development.no-post-verification-mutation)

Re-observe the candidate hash before recording. If it drifted from the frozen
`candidateHash`, all prior evidence is invalid and a new verification workset is
required — do not complete with stale evidence; route to settlement as a
failure.

## Completion

Record each verdict via `verification_record`, read it back, then call
`worker_done` once and exit. Summarize the verified AC id, the pinned candidate
hash, and the outcome truthfully.
