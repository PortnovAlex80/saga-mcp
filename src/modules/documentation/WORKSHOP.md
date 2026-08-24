# WORKSHOP.md — Documentation Release (`documentation-release@1.0.0`)

> Agent entrypoint for the documentation (PDF docs) workshop. Admitted on the
> canonical line 2026-08-24 (ADR-096 gate item 4). An agent should understand
> this workshop from this file + the referenced declarations without global
> repository archaeology.

## 1. Purpose and non-goals

**Purpose:** consume ONE exact verified Development candidate and produce its
rendered PDF documentation set (user manual, programmer manual, operator
manual, acceptance report). Workers author STRUCTURED, schema-valid JSON
documents; a deterministic kernel renders PDFs; a deterministic settlement
issues the certificate.

**Non-goals:** no deployment/release authority (documentation never releases
anything — the `documented` terminal stays `runnable-local`); no repository
mutation by workers (read-only observations only); no LM rendering (rendering
is a deterministic provider capability); no lifecycle routing decisions (the
module emits local outcomes only).

## 2. Module identity/version

- Package: `documentation-release@1.0.0` (canonical ref:
  `DOCUMENTATION_PROCESS_MODULE_REF` in
  `src/process-modules/lifecycles/product-delivery-module-contracts.ts`).
- Definition: `src/process-modules/modules/documentation/documentation-process-module.ts`
  (kind `documentation`, displayName "Documentation Release").
- Manifest: `src/process-modules/modules/documentation/package/manifest.ts`
  (`runtimeCompatibilityRange: '^3.0.0'`, validated at module load, content-addressed at install).

## 3. Input/output contracts

**Input** `factory.documentation-release-case.v1` (from the Development
`verified` handoff — see §15 for the exact mapping):
`developmentCertificate` (exact triple), `verifiedIntegrationBundle` (exact
triple), `integratedCandidateHash`, `candidateRepositories[]`
(`{projectRepositoryId, branch, commitSha, treeHash}`), `srs`,
`acceptanceCriteria`, `documentKinds[]`, `outputRoot`, `initiatedBy`.

**Output** `factory.documentation-bundle.v1`: the immutable record of rendered
PDFs — per document `kind`, the exact document product ref, `pdfFileName`,
`pdfByteHash`, `pdfByteSize`, renderer id/version, plus `candidateHash`,
`outputRoot`, `bundleHash`. Persisted in `factory_documentation_bundles`
(append-only, idempotent by process run).

## 4. Local outcomes

| Outcome | Meaning | Terminal |
|---|---|---|
| `documented` | every planned kind has an accepted product + deterministic render receipt | yes |
| `blocked` | render engine unavailable or human decision required | yes |
| `failed` | integrity, lineage or rendering validation failed | yes |

## 5. Flow diagram

```
documentation-release-case (lifecycle handoff)
  → assemble-documentation-case (kernel)
       validate case; observe repo at EXACT integrated commit;
       emit one fan-out brief per requested kind
  → author-documents (production-cell, fan-out over plan.documents)
       author Workplace → CandidateSet → author Gate (completeness)
       → reviewer → final Gate (review verdict) → FinalAcceptance
  → render-documentation-bundle (kernel)
       probe render provider; absent engine → honest typed blocked
  → settle-documentation (kernel)
       re-read exact rendered workset; certificateRepo.issue
  → complete-documented | complete-blocked | complete-failed
```

## 6. Production Cell and workKey rule

One cell: `documentation-authoring` (node `author-documents`).
Fan-out: `inputSelectors: ['assemble-documentation-case.documents']`,
`materialization: { sourceBinding: 'assemble-documentation-case',
workKeySelector: 'documents', completionPolicy: 'all' }`. The `workKey` is
derived from the assembler production's `semanticDigest` (candidateHash +
sorted kinds) + the stable item `id` — never array position, execution or
time. Brief items carry a string `id` (= the document kind id), satisfying
the `extractItems` stable-identity contract.

## 7. Author/reviewer profiles

- `documentation-writer` (author): executionSkill/semanticSkill
  `saga-documentation-writer`, protocol `saga-process-module-worker-protocol`,
  executionMode `tracker_only`, output `factory.documentation-document.v1`,
  allowedTools = read tools + `product_submit` + `worker_done`.
- `documentation-reviewer`: same skill family, output
  `factory.documentation-review-verdict.v1`, verdict binds the EXACT author
  CandidateSet (`subject_candidate_set_ref`).

## 8. CheckPlans

- Author gate `documentation.document.author.v1`:
  `factory.documentation-completeness.v1` — resolves the exact CandidateSet
  member `managed-node-submission:<id>`, re-reads the payload by content
  hash, validates document structure + per-kind required sections. `'error'`
  never authorizes acceptance.
- Final gate `documentation.document.final.v1`: the shared
  `factory.review-verdict` provider parameterized at
  `factory.documentation-review-verdict.v1`.

## 9. Recovery policies

Cell recovery: `{ maxAttempts: 3, onExhausted: 'requeue' }`; repair stays on
the same Workplace; profile recoveryPolicy `resumeFromCheckpoint`, reuses
WorkIntent and accepted output, `onExhausted: 'pause'`. A `blocked` render
terminal is continuable (§17) — it is not a failure.

## 10. Effects

None. The workshop declares no post-acceptance effect; PDF files are written
by the deterministic render kernel (not an LM effect), and the bundle row is
the durable receipt.

## 11. Kernel handlers

`src/modules/documentation/application/documentation-installation.ts`
(handlers registered by `src/modules/documentation/index.ts`):
`documentation-case-assembler` (deterministic briefs; repo observation at the
exact commit, capped excerpts), `documentation-renderer` (probe → render →
persist bundle; idempotent), `documentation-settlement-policy` (verify the
complete workset; issue certificate; emit local outcome).

## 12. Human/external ports

- `DocumentationRenderProvider` (`domain/documentation-kernel-ports.ts`):
  `probe()` + `render()`; default `pdfKitDocumentationRenderProvider` (lazy
  pdfkit import, DejaVu Cyrillic fonts via `dejavu-fonts-ttf` or
  `SAGA_DOCS_FONT`). **Engine status (2026-08-24): NOT installed in the
  shared node_modules — every render settles honestly typed `blocked`
  (`PDF_RENDERER_FONT_UNAVAILABLE`) until the operator admits
  `pdfkit` + `dejavu-fonts-ttf`.** The orchestrator owns that dependency
  decision (shared junction tree).
- `DocumentationRepositoryObservationPort`: git plumbing reads pinned to the
  exact integrated commit (`createGitDocumentationRepositoryObservation`).
- `DocumentationProductReader`: exact sealed-product reads by
  id+schema+content-hash.
- Human node: none (no human adapter today).

## 13. Artifacts/resources

Package resources under
`src/process-modules/modules/documentation/package/resources/`:
writer SKILL.md, writer/reviewer checklists, document-submit +
review-verdict call templates, stage tracker. Platform-shared protocol skill
pinned from repo root. All hash-closed in the package digest.

## 14. Capability declaration/binding inventory

Declared in the SINGLE factory capability manifest
(`src/process-modules/application/workshop-capability-manifest.ts`, epoch
`2026-08-24-documentation-release`):
payload contracts `factory.documentation-document.v1` +
`factory.documentation-review-verdict.v1` (installed in EVERY process);
check provider `factory.documentation-completeness.v1` (trusted-provider row
with `*_TRUST_DRIFT` fail-closed). No private registration path.

## 15. Lifecycle routes

Lifecycle: `product-documentation-lifecycle` (spreads
`productDeliveryLifecycle`; selected per engine launch via
`SAGA_FACTORY_LIFECYCLE=product-documentation`, default stays
`product-build`; explicit `lifecycleDefinition` composition parameter keeps
precedence). Routes: Development `verified` → `documentation-release`;
`documented` → terminal `runnable-local`; `blocked` → terminal
`documentation-blocked`; `failed` → terminal `failed`. The root input member
`documentation: { kinds, outputRoot }` is required (validated by
`assertProductDocumentationProfile`; injected by the production start path
under the env selection, or carried by the continuation baseline).

## 16. Conformance universe and commands

Pack: `tests/factory-proof/documentation-scenario-pack.mjs` (status SPINE):
- `documentation/missing-engine-blocked` — drivable TODAY (engine absent):
  the full conveyor spine — fan-out authoring, author+final gates, honest
  typed blocked, settlement certificate, terminal routing, exact handoff.
- `documentation/happy-documented` — requires the pdfkit engine (declared,
  pending the dependency decision).

```
node tests/factory-proof/documentation-scenario-drive.mjs            # auto-selects honestly by engine probe
DOCUMENTATION_SCENARIO=documentation/missing-engine-blocked node tests/factory-proof/documentation-scenario-drive.mjs
npm run workshop:inventory:check                                    # includes this workshop
npm run coverage:factory                                            # SPINE ledger (2 scenarios, 13 required, 10 pending)
```

The COMMITTED demonstrated-coverage snapshot
(`tests/factory-evidence/conformance-report.json`) is K0-ledger-frozen
(`tests/factory-proof/k0-baseline.test.mjs`): folding this workshop's PASS
bundles into it is the operator's next `npm run conformance:harvest` + CC-00
re-baselining ceremony, not a per-admission edit.

## 17. Variants/continuations

`src/app/factory-documentation-continuation.ts`: append-only retry of the
`documentation-release` suffix after a `documentation-blocked` parent (e.g.
the operator installed the render engine). Slices the parent's OWN pinned
definition snapshot (a parent without the stage cannot grow one). CLI:
`node scripts/factory.mjs continue <db> --from-lifecycle <id> --documentation
[--kinds a,b] [--out <dir>]`.

## 18. Known platform-owned fault edges

- Render engine absence is an OPERATOR dependency decision, not a workshop
  defect: honest `blocked`, continuable. The provider's `probe()` checks
  fonts synchronously; an engine-present/fonts-absent combination would
  surface as blocked, an engine-absent/fonts-present one as `failed` at
  render — known asymmetry, residual (see the probe note in the render
  provider).
- The bundle table (`factory_documentation_bundles`) is module-owned
  append-only persistence (immutability triggers), per the workshop-owned
  table convention.
