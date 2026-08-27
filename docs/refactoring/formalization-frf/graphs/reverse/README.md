# FRF-WP02 — Reverse Graph (handoff + terminal evidence derivation)

The reverse half of FRF-WP02 ("A different agent derives the reverse graph
from handoff and terminal evidence") of
`docs/plans/FORMALIZATION-SCENARIO-FIRST-REFACTORING-PLAN.md`.

Derived **independently** from the plan text and the WP01 baseline ledger
only:

- inputs: the plan's §Development handoff requirements, §Target semantic
  trace grammar, §Desk contracts, the reverse-input clause of §Graph and
  test model, the kill-test/mutation layers, and baseline ledger rows
  D-1/D-2/D-3/D-4/D-17
  (`docs/refactoring/formalization-frf/INTENTIONAL-DIFFERENCE-LEDGER.md`);
- forbidden inputs (not read, per the plan): the forward expected graph,
  installed production source, production validators, production flow
  output, tests/fixtures;
- the graph states what the plan **REQUIRES**, not what installed code
  does — the known installed gaps (UC-FOREIGN acceptance, Development
  consuming nothing) must EMERGE from the coordinator's reconciliation
  diff against this artifact, never from it.

## Files

| File | Purpose |
|---|---|
| `reverse-graph.json` | The versioned machine artifact (canonical JSON). |
| `validate.mjs` | Deterministic internal-consistency validator. |
| `README.md` | This schema documentation. |

Validate:

```bash
node docs/refactoring/formalization-frf/graphs/reverse/validate.mjs
```

Exit 0 = internally consistent and canonical. The validator never reads
anything outside this directory.

## Direction convention

Edges run **from the citing claimant to the cited authority** (demand
direction): a terminal claim cites the material that proves it; a
DevelopmentCase binding cites the accepted artifact ids it must resolve
against; an artifact cites the upstream material it derives from. The
chain therefore reads: terminal claims → settlement/handoff → baseline /
SRS realization → acceptance → requirements → scenarios → intent → brief +
Discovery source claims.

## Top-level schema of `reverse-graph.json`

| Key | Type | Meaning |
|---|---|---|
| `artifact` | string | Always `frf-reverse-graph`. |
| `version` | number | Schema version (1). |
| `derivation` | object | Base SHA, inputs, method, independence statement (reverse-input clause). |
| `authorities` | object | Registry `id -> {doc, summary}`; every id is `plan:§…` (section of the FRF plan) or `ledger:D-n` (baseline ledger row). Every edge/node/rule citation must resolve here, and every declared authority must be cited. |
| `vocabularies` | object | Closed binding vocabularies (below). |
| `nodes` | array | 39 nodes: 9 terminal claims + 30 material kinds. |
| `edges` | array | 94 reverse edges, zero-padded ids `edge/0001`…`edge/0094`. |
| `coverageRules` | array | 12 completeness/kill laws (`cr-01`…`cr-12`), each with authority. |
| `exclusions` | array | What the derivation deliberately did not assume (`x-1`…`x-4`). |
| `ambiguities` | array | 7 recorded plan ambiguities and how each was resolved (`a-1`…`a-7`). |
| `residuals` | array | 4 open items for the coordinator (`r-1`…`r-4`). |

### Node fields

| Field | Type | Meaning |
|---|---|---|
| `id` | string | `claim/<terminal>/<slug>` or `material/<slug>`. |
| `kind` | string | Must exist in `vocabularies.nodeKinds`. |
| `chainRole` | string | `claim` (root, no incoming), `material` (≥1 in, ≥1 out), `leaf-authority` (no outgoing; source/kernel evidence). |
| `layer` | string | Coarse layer: terminal, development, settlement, freeze, architecture, acceptance, requirements, scenarios, intent, source, evidence, kernel. |
| `label`, `description` | string | Human-readable. |
| `authority` | string[] | Non-empty; every entry resolves in `authorities`. |

### Edge fields

| Field | Type | Meaning |
|---|---|---|
| `id` | string | `edge/NNNN`, sorted. |
| `from`, `to` | string | Existing node ids; direction = cites. |
| `kind` | string | Citation semantics (e.g. `carries-required-value`, `derived-from-intent`, `freezes-container-and-members`). |
| `bindingKind` | string? | One of the twelve `vocabularies.handoffBindingKinds.values` — the typed, required DevelopmentCase value this edge realizes. |
| `obligationKind` | string? | One of the five `vocabularies.workItemObligationKinds.values` (WorkItem edges only). |
| `grammarRule` | string? | One of the eight `vocabularies.traceGrammarRules` — the §Target semantic trace grammar line this edge reverses. |
| `via` | string[]? | The contract fields that establish the trace (e.g. the realization-entry field list). |
| `constraint` | string? | Cardinality/rejection semantics the plan attaches to this citation. |
| `authority` | string[] | Non-empty; resolves in `authorities`. |

### Vocabularies

- `handoffBindingKinds` (12) — the plan's §Development handoff requirements
  value list, each with its installed `DevelopmentHandoff` field name
  (ledger D-17) and the accepted id set it must resolve against.
- `workItemObligationKinds` (5) — acceptance / scenario-realization /
  requirement / integration-or-composition / infrastructure obligations.
- `traceGrammarRules` (8) — the plan's semantic trace grammar lines.
- `intentDispositions` (4) — scenario_required / direct_requirement /
  deferred / out_of_scope with their fences.
- `evidenceKinds` (4) — test / monitoring / audit / independent-agent-review.
- `actorKinds` (5) — human / operator / external_system / scheduler_or_clock /
  sensor_or_environment (closed; never actorless, never human-only).
- `planInvalidOmissions` (5) — scenario entrypoint / runtime edge /
  composition owner / terminal result / verifier.
- `nodeKinds` — the node kind registry.

## Determinism

- Recursive key sort, 2-space indent, trailing newline; the file must be
  byte-identical to its canonical serialization (validator check V1).
- `nodes`, `edges`, and id-bearing sections are sorted by id; `authorities`
  is a sorted-key registry.
- No timestamps, generated-ats, or volatile fields anywhere in the body
  (validator check V2); identity is the content hash of this file plus the
  base SHA recorded in `derivation.base`.

## Graph summary

- 9 claims under the three terminals: 7 positive claims for
  `complete-formalized` (both authorities sealed, baseline complete, chain
  closed, scenario survival, source-intent coverage, terminal results
  provable, Development handoff complete) plus one detection claim each for
  `complete-inconsistent` (drift detected, no mutation) and
  `complete-failed` (gate failed).
- Key reverse chains:
  - `claim …/both-authorities-sealed` → `solution-contract` →
    `whole-what-baseline` + `srs` (exact refs + hashes) → all frozen
    containers/members → PRD intent → brief + Discovery source claims;
  - `claim …/development-handoff-complete` → `development-case` carrying
    all twelve binding kinds → `development-plan` → `workitem` → the five
    obligation kinds → AC criteria / SRS realization / FR/NFR/RULE /
    composition + infrastructure obligations;
  - `srs-scenario-realization` → `uc-scenario` → `prd-intent-member` →
    `discovery-source-claim`;
  - scenario-facing `ac-criterion` → `uc-scenario` + `uc-terminal-branch`;
  - `terminal-claim` → PRD lifecycle-terminal-claim member, UC terminal
    result, SRS terminal observable result; verified by
    `verifier-obligation`.

## Ambiguities and residuals

See the `ambiguities` (`a-1`…`a-7`) and `residuals` (`r-1`…`r-4`) arrays
in the JSON. Highlights: the plan never names a container for terminal-claim
binding targets (a-1); "product-verifier obligations" is only defined by
the reverse-input clause (a-3); the baseline's folded-vs-enumerated
disposition sections (ledger D-10) cannot be resolved from the handoff side
alone (r-3).
