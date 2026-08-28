# define-product-intent desk — author submission summary (r2)

**Desk:** define-product-intent (formalization entry desk, FRF-WP04 Production Cell)
**Role:** author
**Submission ID:** FS-Define-Product-Intent-001
**Submitted:** 2026-08-28T00:00:00Z (pinned, deterministic)
**Workspace:** 0 accepted upstream revisions travel by content address

## What was authored

| Artifact | Content address |
|---|---|
| Product-intent bundle (`frf-cell.product-intent.v1`) | `sha256:a06dbc57ba63eb8541c6478e3aba1012af52c8084de0e2fb7719256ffde1e055` |
| Product-intent trace | `sha256:6e35f34ccb5a74cb18e2b0c8a7302587018a6e4a11baa787c1a5815926eb35d9` |
| Product submission + intake receipt | `sha256:91878e07e14b01789737d9a7bd49075c01a9691f7c751b339bd2d34727ba50e0` |

## The PRD intent bundle

Brief: "Message service product intent authored from the accepted Discovery handoff capsule: deterministic responses only, the accepted outcome delivered with an audited go terminal state, and the browser support matrix carried forward as a discovery-owned unknown."

Six WP03 intent members (`frf-contracts.prd-intent-member.v1`), all four dispositions exercised, every member seal recomputed over canonical member content:

| Member | Kind | Disposition | Source claims | Terminals owned |
|---|---|---|---|---|
| `prd:boundary-1` | system-boundary | scenario_required | `claim:scope-1` | — |
| `prd:scope-2` | scope-exclusion | out_of_scope (owner `product-owner`) | `claim:scope-2` | — |
| `prd:constraint-1` | constraint | direct_requirement | `claim:constraint-1` | — |
| `prd:outcome-1` | outcome | scenario_required | `claim:outcome-1`, scope `claim:scope-1` | `terminal:delivered-1` |
| `prd:terminal-1` | terminal-claim | scenario_required | `claim:outcome-1` | `terminal:audited-1` |
| `prd:unknown-1` | assumption-unknown | deferred (owner `discovery`) | `claim:constraint-1` | — |

Coverage law: all four accepted source claims (`claim:scope-1`, `claim:scope-2`, `claim:constraint-1`, `claim:outcome-1`) are realized or explicitly dispositioned. Fence respected: no final acceptance/FR/NFR/RULE/scenarios/SRS/UC content anywhere in the bundle.

## Upstream material authority

Imported from the r2 `import-discovery-handoff` desk product:

- Import artifact: `sha256:b10bb762b652fe89be23eaf3073c619a448ab52559eabba24d2715374e357dd5`
- Capsule self-address: `sha256:f3f98175f061fa289d49f4684f78273022c97b9e12bc535255c4b3d4c6a0534e`
- All eight sub-artifact digests cross-checked against this desk task's task-projection envelope (declared digests never trusted):

  - `claim:scope-1` → `b15c35da54dd016492f397d71a59883d38cfb0c5e55aaa51f68c4d3f210d1909`
  - `claim:scope-2` → `cb291aa71e7be582a96811d65be7d59bf66949b76fb1faa8fc7d1d421f0837da`
  - `claim:constraint-1` → `6652762b7d8d26aacbaeb11f1b1e1529b26c2974ecf8ab0a01f0eb2b651d753b`
  - `claim:outcome-1` → `3d576e96e9c101b4b7187be8ce0d6f4542c161e8b8f9fa7323397329ac4e85b0`
  - `constraint:retention-1` → `807393968f3d6e0e10f502544a9a4f6345727af5cfdfabf00f0319c9288945be`
  - `unknown:browser-matrix-1` → `38fc9cb187adaf2527e9233f75acd6a5283b74ddce292318e6b027c8d345baaf`
  - `terminal:audited-1` → `4a559317fdfd23d4286fd9b0859d10d714a10f971357b33f4a4202db05dd056f`
  - `terminal:delivered-1` → `8ce2f289656b7447911eedbd261a9243bbb8e43a1d3e4479e366f4be5b3cc988`

## Dispositions

- **constraint:retention-1** — honored: all authored desk content is deterministic (pinned timestamp, no clock reads, no randomness, canonical-JSON digests only); enforced verbatim by member `prd:constraint-1`.
- **unknown:browser-matrix-1** — carried forward, owner `discovery`: no resolution edge is recorded; the unknown travels into the downstream desks (honest open item).

## Trace coverage

- `terminal:audited-1`: supported by `prd:terminal-1`.
- `terminal:delivered-1`: supported by `prd:outcome-1`.
- Member/terminal/constraint/unknown coverage blocks are exact projections of the relationship edge set (recomputed, never hand-maintained).

## Governing contract

`AC-Define-Product-Intent-001` (`sha256:a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837`, protocol-skill layer of this desk task). All ten acceptance criteria are self-checked in the submission payload and mechanically re-verified by `define-product-intent-desk-author-verify.mjs` (runs the REAL WP03 validator `validatePrdIntentMember` against the accepted id-set universe).

## Hand-off

Candidate admitted for the **reviewer** stage; on acceptance the successor desk is **model-use-cases** (which models scenarios against exactly this accepted intent set).

**Digest rule (all artifacts):** sha256 over canonical JSON of `content` (recursively key-sorted, compact); envelope refs derive from that digest.
