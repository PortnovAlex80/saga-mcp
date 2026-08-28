# model-use-cases desk — author submission summary (r2)

**Desk:** model-use-cases (formalization desk, FRF-WP04 Production Cell)
**Role:** author
**Submission ID:** FS-Model-Use-Cases-001
**Submitted:** 2026-08-28T00:00:00Z (pinned, deterministic)
**Workspace:** 0 accepted upstream revisions travel by content address

## What was authored

| Artifact | Content address |
|---|---|
| UC scenarios bundle (`frf-cell.uc-scenarios.v1`) | `sha256:24f0aff29b3fc3a3e021c79c771e798cd46cc490ff0bda02d7e25133fbbf8a4b` |
| UC scenarios trace | `sha256:f49ddc6fc7d6ca3cad0d0e27e9d9a8a158eabef55d4437e0023519fdaed08c85` |
| Product submission + intake receipt | `sha256:9209335d51f98168a2f9574ec1181eb468a3087b34acde44f68b54010dd39047` |

## The UC scenarios bundle

Brief: "Message service UC scenarios modeled against the exact accepted define-product-intent bundle: one scenario per scenario_required intent member (boundary, delivered outcome, audited terminal), deterministic responses only, the browser support matrix carried forward as a discovery-owned unknown."

Three WP03 scenario members (`frf-contracts.uc-scenario-member.v1`), exactly the ids the cell protocol seeds from the accepted fold (`uc:<member-suffix>`), every scenario seal recomputed over canonical member content:

| Scenario | Actor (kind / identity) | Terminal branches | PRD intent lineage | Terminal supported |
|---|---|---|---|---|
| `uc:boundary-1` | human / message service user with a service account | 1 main | `prd:boundary-1` | — |
| `uc:outcome-1` | human / message service user with a service account | 1 main + 1 deterministic error | `prd:outcome-1` | `terminal:delivered-1` |
| `uc:terminal-1` | operator / message service operator performing terminal triage | 1 main | `prd:terminal-1` | `terminal:audited-1` |

Scenario seals: `uc:boundary-1` → `defe9b1f817b1e975e2476bcded8d02e150222bab679fe65adae8dd7e6d3137d`, `uc:outcome-1` → `ceb0fa710e0388dbd7f69d38b911d0bafb71209f4ad0d9c616c6cfdbbd75285d`, `uc:terminal-1` → `e711405c4b8a20742ea90545d43b46babe52de676f5cb027f8568daba540b543`.

Never actorless: closed five-value `actorKind` + `actorIdentity` on every scenario. Exactly one main terminal branch per scenario; every material flow resolves to a declared branch of its own kind. The error branch of `uc:outcome-1` returns a deterministic error response and invents no nondeterministic content.

## Upstream material authority

Consumed from the r2 accepted `define-product-intent` product (0 revisions travel by content address):

- Accepted intent bundle: `sha256:a06dbc57ba63eb8541c6478e3aba1012af52c8084de0e2fb7719256ffde1e055`
- Upstream seals re-verified through the REAL `validatePrdIntentMember`; the accepted-intent fold re-derived with the REAL `acceptedIntentSetOf` (revision digest `a30229a75bed4c5d7b4a9660f6a7644d333e6c0c63064901da9aa020cadca770`; scenario_required = `prd:boundary-1`, `prd:outcome-1`, `prd:terminal-1`).
- All eight capsule sub-artifact digests cross-checked against this desk task's task-projection envelope (declared digests never trusted):

  - `claim:scope-1` → `b15c35da54dd016492f397d71a59883d38cfb0c5e55aaa51f68c4d3f210d1909`
  - `claim:scope-2` → `cb291aa71e7be582a96811d65be7d59bf66949b76fb1faa8fc7d1d421f0837da`
  - `claim:constraint-1` → `6652762b7d8d26aacbaeb11f1b1e1529b26c2974ecf8ab0a01f0eb2b651d753b`
  - `claim:outcome-1` → `3d576e96e9c101b4b7187be8ce0d6f4542c161e8b8f9fa7323397329ac4e85b0`
  - `constraint:retention-1` → `807393968f3d6e0e10f502544a9a4f6345727af5cfdfabf00f0319c9288945be`
  - `unknown:browser-matrix-1` → `38fc9cb187adaf2527e9233f75acd6a5283b74ddce292318e6b027c8d345baaf`
  - `terminal:audited-1` → `4a559317fdfd23d4286fd9b0859d10d714a10f971357b33f4a4202db05dd056f`
  - `terminal:delivered-1` → `8ce2f289656b7447911eedbd261a9243bbb8e43a1d3e4479e366f4be5b3cc988`

## Dispositions

- **constraint:retention-1** — honored: every authored scenario step carries deterministic content only (pinned timestamp, no clock reads, no randomness, canonical-JSON digests only); the `uc:outcome-1` error branch states the constraint verbatim.
- **unknown:browser-matrix-1** — carried forward, owner `discovery`: no resolution edge is recorded; no scenario, branch or evidence kind is derived from it (honest open item traveling into the downstream desks).

## Coverage law (UC coverage fence)

All three `scenario_required` upstream members are covered by at least one scenario's `prdIntentRefs`: `prd:boundary-1` ← `uc:boundary-1`, `prd:outcome-1` ← `uc:outcome-1`, `prd:terminal-1` ← `uc:terminal-1`. `prd:scope-2` (out_of_scope at intent freeze) derives no scenario; `prd:constraint-1` (direct_requirement) and `prd:unknown-1` (deferred) require no scenario coverage. Fence respected: no acceptance/FR/NFR/RULE/requirements content anywhere in the bundle (typed SCOPE_VIOLATION).

## Trace coverage

- `terminal:audited-1`: supported by `uc:terminal-1` (ownership stays upstream: `prd:terminal-1`).
- `terminal:delivered-1`: supported by `uc:outcome-1` (ownership stays upstream: `prd:outcome-1`).
- Scenario/PRD-member/terminal/constraint coverage blocks are exact projections of the relationship edge set (recomputed, never hand-maintained); 0 edges touch the carried unknown.

## Governing contract

`sha256:a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837` (protocol-skill layer of this desk task). All ten acceptance criteria are self-checked in the submission payload and mechanically re-verified by `model-use-cases-desk-author-verify.mjs`: it runs the REAL WP03 validator `validateUcScenarioMember` against the exact accepted id-set universe, re-folds the upstream intent set with the REAL `acceptedIntentSetOf`, runs the REAL cell gate `evaluateUcGate` (verdict **accepted**, downstream `AcceptedScenarioSet` folded: scenario ids, branch ids per owning scenario, covered PRD member ids), and negative-probes the validator (FOREIGN_LINEAGE, SCOPE_VIOLATION, actorless, gate foreign lineage → upstream-repair, missing upstream → UPSTREAM_NOT_SUPPLIED). 64/64 checks pass.

## Hand-off

Candidate admitted for the **reviewer** stage; on acceptance the successor desk is **derive-system-requirements** (which derives FR/NFR/RULE material bound against exactly this accepted scenario set, branch identities recorded at their own level per owning scenario).

**Digest rule (all artifacts):** sha256 over canonical JSON of `content` (recursively key-sorted, compact); envelope refs derive from that digest.
