// tests/factory-proof/obligation-contracts.mjs
//
// W0-2 (ADR-084, brief revision a8014c03) — the versioned
// AcceptanceObligationContract set: the NORMATIVE source of "what the
// Factory must protect", compiled into mutant families by
// mutation-algebra.mjs and reconciled against the installed protection
// surface by installed-protection-reader.mjs.
//
// INDEPENDENCE CONTRACT (the oracle rule):
//   - this file imports NOTHING from dist/ (no validators, no CheckProviders,
//     no installed CheckPlans) and writes nothing to any DB;
//   - expected protections are keyed by the DECLARED logical identities of
//     the workshop capability manifest — the installed reader discovers the
//     actual surface, this file never reads it;
//   - a human/architect declares each protected property ONCE (at contract or
//     gate creation/migration); nobody writes per-gate negative fixtures.
//
// Constraint kinds (the relational mutation algebra's input vocabulary):
//   cardinality | unique | grammar | ref | digestOf | equality | subset |
//   projection  | lineage | ordering | version | crossField

export const CONTRACT_SCHEMA_VERSION
  = 'factory.proof.acceptance-obligation-contract.v1';

export const CONSTRAINT_KINDS = Object.freeze([
  'cardinality', 'unique', 'grammar', 'ref', 'digestOf', 'equality',
  'subset', 'projection', 'lineage', 'ordering', 'version', 'crossField',
]);

export const FAULT_CLASSES = Object.freeze([
  'authored-semantic', 'contract-shape', 'authority-binding',
  'derived-evidence', 'detector-fault', 'feedback-fault',
  'durable-transition', 'effect-external', 'scheduler-fence',
]);

export const ORACLE_CLASSES = Object.freeze([
  'mechanical', 'semantic-adjudicated', 'harvested',
]);

const PROTECTION_KINDS = Object.freeze([
  'check-provider', 'post-acceptance-effect', 'transition-handler',
  'payload-contract',
]);

/**
 * Pure structural validator for one contract. Independent of any production
 * declaration — the schema lives here, in the normative source.
 */
export function validateObligationContract(contract) {
  const errors = [];
  const fail = m => errors.push(m);
  if (!contract || typeof contract !== 'object') return ['contract must be an object'];
  if (typeof contract.obligationId !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/.test(contract.obligationId)) {
    fail('obligationId must be a kebab-case string');
  }
  if (typeof contract.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(contract.version)) {
    fail(`version must be semver, got ${contract.version}`);
  }
  if (!Array.isArray(contract.sourceRefs) || contract.sourceRefs.length === 0
    || contract.sourceRefs.some(r => typeof r !== 'string' || r.length < 3)) {
    fail('sourceRefs must be a non-empty array of references (REG/PROC/ADR/failure-axis)');
  }
  if (typeof contract.subjectKind !== 'string') fail('subjectKind required');
  if (typeof contract.protectedProperty !== 'string' || contract.protectedProperty.length < 10) {
    fail('protectedProperty must state the protected property');
  }
  if (!Array.isArray(contract.constraints) || contract.constraints.length === 0) {
    fail('at least one constraint is required (mutation families compile from them)');
  }
  for (const c of contract.constraints) {
    if (!c || !CONSTRAINT_KINDS.includes(c.kind)) {
      fail(`unknown constraint kind ${JSON.stringify(c?.kind)}`);
    }
  }
  const ep = contract.expectedProtection;
  if (!ep || !PROTECTION_KINDS.includes(ep.kind)) {
    fail(`expectedProtection.kind must be one of ${PROTECTION_KINDS.join('|')}`);
  }
  if (!ep || typeof ep.logicalId !== 'string' || ep.logicalId.length === 0) {
    fail('expectedProtection.logicalId required (manifest key)');
  }
  if (!Array.isArray(contract.faultClasses) || contract.faultClasses.length === 0
    || contract.faultClasses.some(f => !FAULT_CLASSES.includes(f))) {
    fail('faultClasses must be a non-empty subset of the declared fault taxonomy');
  }
  if (!contract.oracleClass || !ORACLE_CLASSES.includes(contract.oracleClass)) {
    fail(`oracleClass must be one of ${ORACLE_CLASSES.join('|')}`);
  }
  const mp = contract.mutationProfile;
  if (!mp || typeof mp.structural !== 'boolean' || typeof mp.relational !== 'boolean'
    || (mp.semanticProfileRef !== null && typeof mp.semanticProfileRef !== 'string')) {
    fail('mutationProfile {structural:boolean, relational:boolean, semanticProfileRef:string|null} required');
  }
  const rc = contract.requiredCorpus;
  if (!rc || ['positive', 'negative', 'repair', 'ignoredFeedback']
    .some(k => typeof rc[k] !== 'string')) {
    fail('requiredCorpus must name all four causal corpus classes');
  }
  if (!Array.isArray(contract.allowedTerminalKinds) || contract.allowedTerminalKinds.length === 0) {
    fail('allowedTerminalKinds must be a non-empty set');
  }
  return errors;
}

// ---------------------------------------------------------------------------
// The contract set — one entry per INSTALLED protection (the set-equality
// surface). Sources are the normative documents, not implementation files.
// ---------------------------------------------------------------------------

const mp = (structural = true, relational = true, semanticProfileRef = null) =>
  ({ structural, relational, semanticProfileRef });
const corpus = (id) => ({
  positive: `${id}/positive`,
  negative: `${id}/negative`,
  repair: `${id}/repair`,
  ignoredFeedback: `${id}/ignored-feedback`,
});

export const ACCEPTANCE_OBLIGATION_CONTRACTS = Object.freeze([
  // ---- Development check-providers ----------------------------------------
  Object.freeze({
    obligationId: 'dev.impl-claim-monotonicity',
    version: '1.0.0',
    sourceRefs: ['STAGE-18 R2 (fc062f77)', 'matrix E8', 'CONVEYOR-MENTAL-MODEL §15'],
    subjectKind: 'implementation-submission-surface',
    protectedProperty: 'A card may not silently narrow its previously claimed file surface between submissions; the only lawful exit is an explicit droppedFiles disposition.',
    constraints: [
      { kind: 'subset', member: 'claimedFiles', of: 'priorClaimedFiles', exemption: 'droppedFiles disposition' },
      { kind: 'projection', field: 'droppedFiles', requires: ['path', 'reason'] },
    ],
    expectedProtection: { kind: 'check-provider', logicalId: 'development.implementation-claim-monotonicity.v1', version: '1.0.0' },
    faultClasses: ['authority-binding', 'contract-shape'],
    oracleClass: 'mechanical',
    mutationProfile: mp(),
    requiredCorpus: corpus('dev.impl-claim-monotonicity'),
    allowedTerminalKinds: ['repair_required', 'failed'],
  }),
  Object.freeze({
    obligationId: 'dev.impl-scope',
    version: '1.0.0',
    sourceRefs: ['STAGE-18 R1 (b9bcb063)', 'W-F1 widening ledger', 'ADR-053 §C5'],
    subjectKind: 'implementation-change-surface',
    protectedProperty: 'Implementation touches only files inside the effective change scopes: frozen carve plus granted widenings, resolved at claim time.',
    constraints: [
      { kind: 'subset', member: 'changedFiles', of: 'effectiveChangeScopes' },
    ],
    expectedProtection: { kind: 'check-provider', logicalId: 'development.implementation-scope.v1', version: '2.1.0' },
    faultClasses: ['authority-binding'],
    oracleClass: 'mechanical',
    mutationProfile: mp(),
    requiredCorpus: corpus('dev.impl-scope'),
    allowedTerminalKinds: ['repair_required', 'failed'],
  }),
  Object.freeze({
    obligationId: 'dev.readiness-monotonicity',
    version: '1.0.0',
    sourceRefs: ['CERTIFICATION-GAMING-REMEDY M1-a', 'ADR-070'],
    subjectKind: 'readiness-declaration-sequence',
    protectedProperty: 'Readiness declarations are monotonic: a narrowed surface or a declaration diff escalates instead of silently passing certification.',
    constraints: [
      { kind: 'ordering', field: 'readinessDeclarations' },
      { kind: 'crossField', rule: 'narrowed-surface implies escalation' },
    ],
    expectedProtection: { kind: 'check-provider', logicalId: 'development.readiness-profile-monotonicity.v1', version: '1.0.0' },
    faultClasses: ['authority-binding', 'contract-shape'],
    oracleClass: 'mechanical',
    mutationProfile: mp(),
    requiredCorpus: corpus('dev.readiness-monotonicity'),
    allowedTerminalKinds: ['repair_required', 'failed'],
  }),
  Object.freeze({
    obligationId: 'dev.replan-graph',
    version: '1.0.0',
    sourceRefs: ['REPLAN-CYCLE-TZ §2'],
    subjectKind: 'cycle-2-task-graph',
    protectedProperty: 'A cycle-2 plan declares unique work items and at least one item (no empty re-plan).',
    constraints: [
      { kind: 'unique', by: 'taskKey' },
      { kind: 'cardinality', min: 1, member: 'workItems' },
    ],
    expectedProtection: { kind: 'check-provider', logicalId: 'development.replan-graph.v1', version: '1.0.0' },
    faultClasses: ['contract-shape'],
    oracleClass: 'mechanical',
    mutationProfile: mp(),
    requiredCorpus: corpus('dev.replan-graph'),
    allowedTerminalKinds: ['repair_required'],
  }),
  Object.freeze({
    obligationId: 'dev.task-graph',
    // v1.3.0 — BM-5/MM-4: §2.2 tokens identity-resolved against the §D2/§D1
    // surface; ambiguous basenames fail typed srs-file-identity-conflict
    // pre-worker. v1.4.0 — Red-Team correction follow-up: segment-aligned
    // token resolution (basename masking closed), register-conditional
    // truthful conflict message, and code-scoped upstream routing — the
    // three plan-independent frozen-SRS codes escalate to 'failed' instead
    // of charging planner repair attempts.
    version: '1.4.0',
    sourceRefs: ['development-process-module', 'GRAPH-TEST-STRATEGY L3 fan-out'],
    subjectKind: 'development-task-graph',
    protectedProperty: 'The task graph has unique item keys, at least one item, and dependsOn edges reference existing keys (no foreign dependencies).',
    constraints: [
      { kind: 'unique', by: 'itemKey' },
      { kind: 'cardinality', min: 1, member: 'items' },
      { kind: 'ref', field: 'dependsOn', target: 'itemKey' },
    ],
    expectedProtection: { kind: 'check-provider', logicalId: 'development.task-graph-contract.v1', version: '1.4.0' },
    faultClasses: ['contract-shape', 'authority-binding'],
    oracleClass: 'mechanical',
    mutationProfile: mp(),
    requiredCorpus: corpus('dev.task-graph'),
    allowedTerminalKinds: ['repair_required', 'failed'],
  }),
  Object.freeze({
    obligationId: 'dev.verification-product',
    version: '2.0.0',
    sourceRefs: ['candidate-check-contracts v2', 'LR-07 binding'],
    subjectKind: 'candidate-verification-product',
    protectedProperty: 'A verification product binds the exact candidate hash under the v2 schema — never a foreign or stale candidate.',
    constraints: [
      { kind: 'digestOf', field: 'candidateHash', of: 'frozen integrated candidate' },
      { kind: 'equality', field: 'schemaVersion', value: 'factory.candidate-verification-evidence-product.v2' },
    ],
    expectedProtection: { kind: 'check-provider', logicalId: 'development.verification-product-contract.v2', version: '2.0.0' },
    faultClasses: ['derived-evidence', 'authority-binding'],
    oracleClass: 'mechanical',
    mutationProfile: mp(),
    requiredCorpus: corpus('dev.verification-product'),
    allowedTerminalKinds: ['repair_required', 'failed'],
  }),

  // ---- Discovery check-providers ------------------------------------------
  // v1.1.0 (2026-08-21, Wave F0 registry cleanup): the field is
  // `recommended_outcome`, not `outcome` — the proposal payload contract was
  // renamed when the kernel took ownership of schema_version pinning. Word
  // grammar unchanged (go|clarify|reject).
  Object.freeze({
    obligationId: 'discovery.proposal-contract',
    version: '1.1.0',
    sourceRefs: ['discovery-check-providers', 'W9-04 deleted-outcome-word', 'discovery-proposal.ts recommended_outcome'],
    subjectKind: 'discovery-proposal',
    protectedProperty: 'A proposal carries a declared recommended_outcome from the closed grammar; deleted words are rejected, never translated.',
    constraints: [
      { kind: 'grammar', field: 'recommended_outcome', pattern: '^(go|clarify|reject)$' },
    ],
    expectedProtection: { kind: 'check-provider', logicalId: 'discovery.proposal-contract.v1', version: '1.0.0' },
    faultClasses: ['contract-shape'],
    oracleClass: 'mechanical',
    mutationProfile: mp(),
    requiredCorpus: corpus('discovery.proposal-contract'),
    allowedTerminalKinds: ['repair_required'],
  }),
  // v1.2.0 (2026-08-21, Wave F0 registry cleanup): Readiness v2
  // (`factory.discovery-readiness-assessment.v2`) binds the assessed Proposal
  // by content hash ONLY (physical ids are provenance, never semantic
  // content) and classifies all seven required dimensions. The old
  // `fileDeclarations` vocabulary described the pre-v2 payload.
  Object.freeze({
    obligationId: 'discovery.readiness-contract',
    version: '1.2.0',
    sourceRefs: ['discovery-check-providers', 'discovery-readiness-assessment.ts v2'],
    subjectKind: 'discovery-readiness-declaration',
    protectedProperty: 'A readiness assessment binds the accepted Proposal by proposal_content_hash only, classifies every required dimension with a legal status, and draws recommended_next_action from the closed grammar.',
    constraints: [
      { kind: 'ref', field: 'proposal_content_hash', target: 'accepted proposal content hash' },
      { kind: 'cardinality', min: 7, member: 'requiredDimensions' },
      { kind: 'grammar', field: 'recommended_next_action', pattern: '^(proceed_to_settlement|request_clarification|repeat_discovery|reject|manual_review)$' },
    ],
    expectedProtection: { kind: 'check-provider', logicalId: 'discovery.readiness-contract.v1', version: '1.1.0' },
    faultClasses: ['contract-shape', 'detector-fault'],
    oracleClass: 'mechanical',
    mutationProfile: mp(),
    requiredCorpus: corpus('discovery.readiness-contract'),
    allowedTerminalKinds: ['repair_required'],
  }),

  // ---- Factory-generic check-providers ------------------------------------
  Object.freeze({
    obligationId: 'factory.accessible-counter',
    version: '1.0.0',
    sourceRefs: ['candidate-check-contracts'],
    subjectKind: 'counter-observation',
    protectedProperty: 'The counter observation projects an exact observed value from the declared sandbox.',
    constraints: [
      { kind: 'projection', field: 'counterObservation', requires: ['observedValue'] },
    ],
    expectedProtection: { kind: 'check-provider', logicalId: 'factory.accessible-counter-sandbox-check.v1', version: '1.0.0' },
    faultClasses: ['derived-evidence'],
    oracleClass: 'mechanical',
    mutationProfile: mp(),
    requiredCorpus: corpus('factory.accessible-counter'),
    allowedTerminalKinds: ['repair_required'],
  }),
  Object.freeze({
    obligationId: 'factory.authorized-observer',
    version: '1.0.0',
    sourceRefs: ['candidate-check-contracts', 'ADR-042/043'],
    subjectKind: 'external-observation',
    protectedProperty: 'An observation is accepted only from a registered trusted observer identity.',
    constraints: [
      { kind: 'ref', field: 'observerId', target: 'trustedProviders' },
    ],
    expectedProtection: { kind: 'check-provider', logicalId: 'factory.authorized-verification-observer.v1', version: '1.0.0' },
    faultClasses: ['authority-binding', 'detector-fault'],
    oracleClass: 'mechanical',
    mutationProfile: mp(),
    requiredCorpus: corpus('factory.authorized-observer'),
    allowedTerminalKinds: ['repair_required', 'failed'],
  }),
  // v1.16.0 (2026-08-24, HUMAN-GATE-CONSOLE): the runnability provider
  // bumped 1.15.0 → 1.16.0 — a typed unknown consults the operator's
  // append-only human-gate resolution (same workplace + candidate-bytes
  // guard); accept → passed, reject → failed with the operator feedback as
  // the diagnostic the producing workshop reads; evidence cites the
  // resolution row; no row / table missing / bytes mismatch keeps the
  // unknown unchanged. The obligation pin moves in the SAME change.
  // v1.15.0 (2026-08-23, CC-GAP-7 / CONFORMANCE-CLOSURE-PLAN warrant
  // execution): the runnability provider's identity bumped 1.14.0 → 1.15.0 —
  // a manifest-carried VerificationWarrantRef executes through
  // package-declared oracle adapters; the warrant authority is cross-bound
  // DB-only (certificate → frozen register → case expected identities →
  // inherited coverage relay); every non-waived execution-class register
  // entry must be covered by a declared adapter; transport-only loopback
  // evidence is never adapter coverage (uncovered/unsupported claims → the
  // typed warrant-oracle-insufficient unknown — never pass, never
  // product-failed); an absent warrant keeps the explicit legacy path; the
  // passed receipt binds warrant + adapter identities + the consumed
  // environmentDigest. The obligation pin moves in the SAME change — a
  // deliberate provider migration must update the norm and the manifest
  // together or the compiler fires PROTECTION_VERSION_DIVERGENCE.
  // v1.14.0 (2026-08-23, K19 repair after REJECT): the runnability
  // provider's identity bumped 1.13.0 → 1.14.0 — the base image identity is
  // observed ATOMICALLY (ONE docker image inspect snapshot pairs RepoDigests
  // and the local Id from the SAME response, then tags only the immutable
  // Id; a tag switch between two resolutions of the mutable tag can no
  // longer pair A's manifest digest with B's local id), the provider
  // boundary fails closed typed when a docker describe reaches the receipt
  // without a well-formed sha256 baseImageDigest (product failed, never
  // passed/unknown/retried), and the trusted_providers migration requires
  // the EXACT version→built-in-digest pair (a forged basis on a known
  // legacy version is drift, never laundered). The obligation pin moves in
  // the SAME change — a deliberate provider migration must update the norm
  // and the manifest together or the compiler fires
  // PROTECTION_VERSION_DIVERGENCE.
  // v1.13.0 (2026-08-23, K19 / ADR-083 §2.1 image/dependency identity
  // remainder): the runnability provider's identity bumped 1.12.0 → 1.13.0 —
  // a docker-substrate check resolves the declared image to its OCI REGISTRY
  // MANIFEST DIGEST (RepoDigests; never a floating tag, never the local
  // image id) and fails closed typed on missing/malformed/repo-mismatched/
  // ambiguous/pin-mismatched evidence; the derivation binds the dependency
  // lock identity (dependencyLockDigest over the sealed tree's exact lock
  // material — lock drift is a different environmentDigest); both identities
  // ride every observation and bind the deterministic receipt digest.
  // Identity stays with K19 (ADR-083 §6): identity failures are product
  // `failed`, never the ADR-089 substrate unknown, and consume no substrate
  // retry.
  // (v1.12.0, 2026-08-22, CC-GAP-9 residual / ADR-091): the runnability
  // provider's identity bumped 1.11.0 → 1.12.0 (mid-check TOCTOU re-probe —
  // on an executor/compose step failure the cached availability probe is
  // invalidated and the daemon mechanically re-probed; only the OBSERVED
  // result routes: unavailable/not-linux rides the ADR-089 bounded retry and
  // typed unknown, available+linux keeps the original product `failed`;
  // classification never reads stderr text; compose `down` stays best-effort
  // and distinct from invalid config).
  // (v1.11.0, 2026-08-22, CC-GAP-9 / ADR-089: bounded in-check substrate
  // retry; typed unknown `warrant-blocked-environment` on exhaustion; unknown
  // receipts never replayed, never poison a later pass.)
  Object.freeze({
    obligationId: 'factory.local-runnability',
    version: '1.16.0',
    sourceRefs: ['LR-01..07', 'ADR-070 readiness certification', 'ADR-083 environment identity', 'ADR-089 substrate retry', 'ADR-091 mid-check re-probe', 'CC-GAP-7 warrant execution'],
    subjectKind: 'local-runnability-receipt',
    protectedProperty: 'The local-runnability receipt binds the exact sealed candidate and a passed start probe; a typed unknown consults the operator\'s persisted human-gate resolution for the same workplace and the same candidate bytes (subject-binding guard) — accept converts to passed, reject to failed with the operator feedback in the diagnostic, evidence cites the resolution id and actor, no resolution or a bytes mismatch keeps the unknown (fail-closed); a missing environment precondition is a typed unknown (warrant-blocked-environment) after the bounded in-check retry, never a failed product verdict; a mid-check executor/compose failure is classified only by a mechanical daemon re-probe — observed unavailable/not-linux rides the bounded retry and typed unknown, observed available+linux keeps the original product failure, and stderr text is never a classification input; the environment identity is authoritative — the declared image resolves to its OCI registry manifest digest (never a floating tag, never the local image id; bad identity evidence fails closed typed), observed ATOMICALLY from one docker image inspect snapshot whose RepoDigests and local Id are paired facts of the same response and whose immutable Id alone is tagged (a tag switch between two resolutions of the mutable tag can never split the receipt identity from the executed image), a docker-substrate description without a well-formed sha256 baseImageDigest fails typed at the provider boundary as a product failure (never passed, never unknown, never retried), the dependency lock identity binds the derived environment digest, both bind the deterministic receipt digest (identity failures are product failed, never the substrate unknown), and the trusted-provider migration accepts a legacy row only on the exact version→built-in-digest pair — a forged trust basis on a known version is drift, never laundered. A present VerificationWarrantRef executes only through package-declared oracle adapters: the warrant authority is cross-bound to the discovery certificate (by exact hash, its verified frozen register), the DevelopmentCase\'s authoritative expected cross-bind identities, and the inherited constraint-register coverage relay (identity violations are typed product failures); every non-waived execution-class register entry must be covered by a declared adapter whose deterministic evidence command runs in the same prepared environment inside the substrate attempt; the generic served phases (start + loopback HTTP probe + stop) are transport-only evidence and never adapter coverage — a missing adapter, an unsupported claim, or transport-only evidence that cannot prove a claim yields the typed warrant-oracle-insufficient unknown (never a pass, never a product-failed verdict), and the passed receipt binds the warrant identity, the executed adapter identities/versions, and the consumed derived environmentDigest (ADR-083 §6: consume and receipt-bind, never authorize).',
    constraints: [
      { kind: 'digestOf', field: 'subjectCandidateSetRef', of: 'sealed integrated candidate' },
      { kind: 'equality', field: 'probeOutcome', value: 'passed' },
      { kind: 'grammar', field: 'warrantOutcome', pattern: '^(passed|warrant-oracle-insufficient|warrant-blocked-environment)$' },
    ],
    expectedProtection: { kind: 'check-provider', logicalId: 'factory.local-runnability.v1', version: '1.16.0' },
    faultClasses: ['derived-evidence', 'effect-external'],
    oracleClass: 'mechanical',
    mutationProfile: mp(),
    requiredCorpus: corpus('factory.local-runnability'),
    allowedTerminalKinds: ['repair_required', 'failed'],
  }),
  Object.freeze({
    obligationId: 'factory.product-contract',
    version: '1.0.0',
    sourceRefs: ['standard-check-providers', 'ADR-053 Phase 1'],
    subjectKind: 'product-payload',
    protectedProperty: 'A product submission carries at least one payload contract entry and validates against the pinned contract.',
    constraints: [
      { kind: 'cardinality', min: 1, member: 'payloadContracts' },
      { kind: 'version', field: 'contractVersion' },
    ],
    expectedProtection: { kind: 'check-provider', logicalId: 'factory.product-contract.v1', version: '1.0.0' },
    faultClasses: ['contract-shape'],
    oracleClass: 'mechanical',
    mutationProfile: mp(),
    requiredCorpus: corpus('factory.product-contract'),
    allowedTerminalKinds: ['repair_required'],
  }),
  Object.freeze({
    obligationId: 'factory.review-verdict',
    version: '1.1.0',
    sourceRefs: ['review-verdict-check-provider', 'REG verdict chain'],
    subjectKind: 'review-verdict',
    protectedProperty: 'A verdict uses the closed verdict grammar and one verdict per candidate ordinal.',
    constraints: [
      { kind: 'grammar', field: 'verdict', pattern: '^(approved|changes_requested|defect_proven)$' },
      { kind: 'unique', by: 'candidateRef+ordinal' },
    ],
    expectedProtection: { kind: 'check-provider', logicalId: 'factory.review-verdict.v1', version: '1.1.0' },
    faultClasses: ['authored-semantic', 'contract-shape'],
    oracleClass: 'semantic-adjudicated',
    mutationProfile: mp(),
    requiredCorpus: corpus('factory.review-verdict'),
    allowedTerminalKinds: ['repair_required', 'failed'],
  }),

  // ---- Formalization submission validators (v2.0.0 family) ----------------
  Object.freeze({
    obligationId: 'frm.submission.product-contract',
    version: '2.0.0',
    sourceRefs: ['formalization-check-refs', 'ADR-053 §3 chain'],
    subjectKind: 'formalization-product-bundle',
    protectedProperty: 'The product bundle traces to the brief root through accepted material only.',
    constraints: [
      { kind: 'ref', field: 'briefRoot', target: 'brief artifact' },
      { kind: 'lineage', field: 'traceChain', root: 'brief' },
    ],
    expectedProtection: { kind: 'check-provider', logicalId: 'factory.submission-validator.formalization.product-contract.v1', version: '2.0.0' },
    faultClasses: ['authority-binding'],
    oracleClass: 'mechanical',
    mutationProfile: mp(),
    requiredCorpus: corpus('frm.submission.product-contract'),
    allowedTerminalKinds: ['repair_required'],
  }),
  Object.freeze({
    obligationId: 'frm.submission.use-cases',
    version: '2.0.0',
    sourceRefs: ['formalization-check-refs'],
    subjectKind: 'formalization-use-case-bundle',
    protectedProperty: 'Use cases derive from accepted PRD/FR material.',
    constraints: [
      { kind: 'ref', field: 'derivesFrom', target: 'accepted PRD|FR' },
    ],
    expectedProtection: { kind: 'check-provider', logicalId: 'factory.submission-validator.formalization.use-cases.v1', version: '2.0.0' },
    faultClasses: ['authority-binding'],
    oracleClass: 'mechanical',
    mutationProfile: mp(),
    requiredCorpus: corpus('frm.submission.use-cases'),
    allowedTerminalKinds: ['repair_required'],
  }),
  Object.freeze({
    obligationId: 'frm.submission.acceptance-contract',
    // v2.1.0 (2026-08-22, proof-subset direction repair): the coverage
    // constraint is declared as the UNCOVERED RESIDUE (register ids minus
    // union of covered minus validly waived = empty) — the reverse diff the
    // validator actually enforces (constraintCoverageGapIdList →
    // FORMALIZATION_CONSTRAINT_UNCOVERED). The v2.0.0 declaration
    // (`coveredConstraintIds ⊆ registerIds-minus-waived`) named the opposite
    // direction: production never rejects an extra unknown covered id, so the
    // declared member-side family was unenforceable at this boundary, and a
    // bare member/of flip would only swap which side a mutant rewrites. The
    // residue form keeps the mutated member on the worker-authored coverage
    // side and compiles a mutation-killable family. The grammar constraint
    // drops its inert `member` binding: `atomicCriteria` entries are objects,
    // so the member-bound grammar operator could never derive a text mutant;
    // the field form compiles the live heading family.
    version: '2.1.0',
    sourceRefs: ['acceptance-contract-validator v1.2.0/v2.0.0', '3cf4819a heading gate', 'ADR-053 §3 (DocumentContainer/AtomicContractMember)', 'constraint-coverage remedy', 'ADR-084 reverse-diff oracle', 'ADR-088 §2 register-conditional red'],
    subjectKind: 'formalization-acceptance-bundle',
    protectedProperty: 'Every /^AC-/ artifact code resolves to exactly one level-2/3 document heading (exact accepted bytes); criterion codes are unique; the uncovered register residue — register ids minus union of AC covered_constraint_ids minus validly waived ids — is empty.',
    constraints: [
      { kind: 'cardinality', min: 1, member: 'atomicCriteria' },
      { kind: 'unique', by: 'criterionCode' },
      { kind: 'grammar', field: 'acHeading', pattern: '^#{2,3} AC-[A-Za-z0-9.-]+:\\s+.+$' },
      { kind: 'subset', member: 'uncoveredConstraintResidue', of: 'empty' },
    ],
    expectedProtection: { kind: 'check-provider', logicalId: 'factory.submission-validator.formalization.acceptance-contract.v1', version: '2.0.0' },
    faultClasses: ['contract-shape', 'authority-binding', 'derived-evidence'],
    oracleClass: 'mechanical',
    mutationProfile: mp(),
    requiredCorpus: corpus('frm.submission.acceptance-contract'),
    allowedTerminalKinds: ['repair_required', 'failed'],
  }),
  Object.freeze({
    obligationId: 'frm.submission.reconciliation',
    version: '3.0.0',
    sourceRefs: [
      'formalization-check-refs',
      'constraint-coverage final catch-all',
      'reconciliation-report-validator.ts pinned payload contract (2026-08-21)',
    ],
    subjectKind: 'formalization-reconciliation-report',
    protectedProperty: 'The reconcile-what author\'s report payload satisfies the pinned report contract: status is exactly "reconciled", the rationale is a non-empty string, remaining_gaps is empty (a report admitting unresolved gaps cannot accept the cell), and repairs is an array. The WHAT-graph coverage checks remain the final catch-all behind the payload pin.',
    constraints: [
      { kind: 'projection', field: 'reconciliationReport', requires: ['status', 'rationale', 'remaining_gaps', 'repairs'] },
      { kind: 'grammar', field: 'status', pattern: '^reconciled$' },
      { kind: 'subset', member: 'remainingGaps', of: 'empty' },
    ],
    expectedProtection: { kind: 'check-provider', logicalId: 'factory.submission-validator.formalization.reconciliation.v1', version: '2.0.0' },
    faultClasses: ['contract-shape'],
    oracleClass: 'mechanical',
    mutationProfile: mp(),
    requiredCorpus: corpus('frm.submission.reconciliation'),
    allowedTerminalKinds: ['repair_required'],
  }),
  Object.freeze({
    obligationId: 'frm.submission.srs-contract',
    // v2.1.0 (2026-08-22, proof-subset direction repair): the §D2 coverage
    // constraints are declared as RESIDUES, not as `d2Stanzas ⊆
    // frozenAcCodes`. The old direction named only the foreign-code half;
    // the protected property ("covers every frozen AC code exactly once")
    // lives in the opposite half the declaration never mentioned. A bare
    // member/of flip would mutate the FROZEN baseline — the authority side a
    // worker cannot author — so the mutant family could never be
    // materialized at the worker boundary. Residue form keeps every mutated
    // member on the worker-authored §D2 document: an unrepresented frozen AC
    // (validator gap `represented_by`) and a foreign §D2 code (validator gap
    // `exact-frozen-ac-code`) are each an empty-set obligation on the SRS.
    version: '2.1.0',
    sourceRefs: ['srs-contract-validator', 'FORMALIZATION_SRS_INCOMPLETE gate', 'srs-d2-parser enums', 'ADR-088 §2 register-conditional red'],
    subjectKind: 'srs-contract',
    protectedProperty: 'The §D2 decomposition represents the frozen AC set exactly: every frozen AC code appears in §D2 (unrepresented-frozen-AC residue empty), every §D2 code is a frozen AC code (foreign-D2-code residue empty), each exactly once with a valid ac_kind; enum fields hold declared values.',
    constraints: [
      { kind: 'subset', member: 'unrepresentedFrozenAcResidue', of: 'empty' },
      { kind: 'subset', member: 'foreignD2AcResidue', of: 'empty' },
      { kind: 'unique', by: 'stanzaAcCode' },
      { kind: 'grammar', field: 'acKind', pattern: '^(implementation|verification)$' },
    ],
    expectedProtection: { kind: 'check-provider', logicalId: 'factory.submission-validator.formalization.srs-contract.v1', version: '2.0.0' },
    faultClasses: ['contract-shape', 'authority-binding'],
    oracleClass: 'mechanical',
    mutationProfile: mp(),
    requiredCorpus: corpus('frm.submission.srs-contract'),
    allowedTerminalKinds: ['repair_required', 'failed'],
  }),

  // ---- Post-acceptance effects ---------------------------------------------
  Object.freeze({
    obligationId: 'effect.formalization-accept-products',
    version: '1.0.0',
    sourceRefs: ['ADR-053 C1/C5', 'formalization-accept-products-effect'],
    subjectKind: 'accept-products-effect-input',
    protectedProperty: 'The accept effect records exactly the accepted container hashes of the current lifecycle run.',
    constraints: [
      { kind: 'equality', field: 'acceptedHashes', of: 'frozen baseline projection' },
    ],
    expectedProtection: { kind: 'post-acceptance-effect', logicalId: 'formalization.accept-exact-products.v1', version: '1.0.0' },
    faultClasses: ['durable-transition', 'derived-evidence'],
    oracleClass: 'mechanical',
    mutationProfile: mp(),
    requiredCorpus: corpus('effect.formalization-accept-products'),
    allowedTerminalKinds: ['failed'],
  }),
  Object.freeze({
    obligationId: 'effect.git-integration',
    version: '1.0.0',
    sourceRefs: ['ADR-039 (model writes text, Git belongs to the factory)', 'ADR-074 typed conflict', 'STAGE-18 R3'],
    subjectKind: 'git-integration-effect-input',
    protectedProperty: 'Git integration binds the observed commit tree (treeSha is a tree sha, not a commit sha); conflicts are typed outcomes with preserved evidence.',
    constraints: [
      { kind: 'digestOf', field: 'treeSha', of: 'observed commit tree' },
    ],
    expectedProtection: { kind: 'post-acceptance-effect', logicalId: 'git-integration', version: '1.0.0' },
    faultClasses: ['derived-evidence', 'effect-external'],
    oracleClass: 'mechanical',
    mutationProfile: mp(),
    requiredCorpus: corpus('effect.git-integration'),
    allowedTerminalKinds: ['repair_required', 'failed', 'human_required'],
  }),
  Object.freeze({
    obligationId: 'effect.replay-capture',
    version: '1.0.0',
    sourceRefs: ['CONVEYOR-MENTAL-MODEL §16 two-pass', 'replay-capture-effect'],
    subjectKind: 'replay-capsule',
    protectedProperty: 'A capsule seals production under its semantic replay key — no run ids, no execution identity.',
    constraints: [
      { kind: 'equality', field: 'capsuleKey', of: 'semantic replay key' },
    ],
    expectedProtection: { kind: 'post-acceptance-effect', logicalId: 'replay-capture', version: '1.0.0' },
    faultClasses: ['durable-transition', 'authority-binding'],
    oracleClass: 'mechanical',
    mutationProfile: mp(),
    requiredCorpus: corpus('effect.replay-capture'),
    allowedTerminalKinds: ['failed'],
  }),

  // ---- Transition handlers (the six durable handoffs minus settle-process,
  //      which is a certificate not a manifest capability) --------------------
  Object.freeze({
    obligationId: 'handoff.close-presentation',
    version: '1.0.0',
    sourceRefs: ['REG transition obligations', 'CONVEYOR C2'],
    subjectKind: 'presentation-closure-handoff',
    protectedProperty: 'Every sealed presentation closes through a durable, fenced, idempotent obligation — no silent leak.',
    constraints: [
      { kind: 'cardinality', min: 1, member: 'presentations closed' },
    ],
    expectedProtection: { kind: 'transition-handler', logicalId: 'close-presentation', version: '1.0.0' },
    faultClasses: ['durable-transition'],
    oracleClass: 'mechanical',
    mutationProfile: mp(),
    requiredCorpus: corpus('handoff.close-presentation'),
    allowedTerminalKinds: ['failed'],
  }),
  Object.freeze({
    obligationId: 'handoff.run-gate',
    version: '1.0.0',
    sourceRefs: ['REG gate-run driver', 'gate-run-driver.ts contract'],
    subjectKind: 'gate-run-handoff',
    protectedProperty: 'A gate run completes with a full-decision digest; only a GateDecision moves the cell.',
    constraints: [
      { kind: 'projection', field: 'gateDecision', requires: ['fullDigest', 'verdict'] },
    ],
    expectedProtection: { kind: 'transition-handler', logicalId: 'run-gate', version: '1.0.0' },
    faultClasses: ['durable-transition', 'detector-fault'],
    oracleClass: 'mechanical',
    mutationProfile: mp(),
    requiredCorpus: corpus('handoff.run-gate'),
    allowedTerminalKinds: ['repair_required', 'failed'],
  }),
  Object.freeze({
    obligationId: 'handoff.run-effects',
    version: '1.0.0',
    sourceRefs: ['REG effect receipts', 'TB-9/TB-10/TB-12 crash windows'],
    subjectKind: 'effects-handoff',
    protectedProperty: 'Every declared effect completes with an exact receipt; crash windows converge to receipt or typed wait, never a silent stall.',
    constraints: [
      { kind: 'cardinality', min: 1, member: 'effectReceipts' },
      { kind: 'digestOf', field: 'effectReceipt', of: 'applied effect' },
    ],
    expectedProtection: { kind: 'transition-handler', logicalId: 'run-effects', version: '1.0.0' },
    faultClasses: ['durable-transition', 'effect-external'],
    oracleClass: 'mechanical',
    mutationProfile: mp(),
    requiredCorpus: corpus('handoff.run-effects'),
    allowedTerminalKinds: ['failed', 'human_required'],
  }),
  Object.freeze({
    obligationId: 'handoff.record-final-acceptance',
    version: '1.0.0',
    sourceRefs: ['ADR-053 C1/C5 accepted head', 'factory_cell_final_acceptances'],
    subjectKind: 'final-acceptance-handoff',
    protectedProperty: 'Final acceptance binds the exact accepted candidate set and advances the accepted-authority head atomically.',
    constraints: [
      { kind: 'ref', field: 'acceptedHead', target: 'workplace' },
      { kind: 'digestOf', field: 'candidateSetRef', of: 'sealed candidate set' },
    ],
    expectedProtection: { kind: 'transition-handler', logicalId: 'record-final-acceptance', version: '1.0.0' },
    faultClasses: ['durable-transition', 'authority-binding'],
    oracleClass: 'mechanical',
    mutationProfile: mp(),
    requiredCorpus: corpus('handoff.record-final-acceptance'),
    allowedTerminalKinds: ['failed'],
  }),
  Object.freeze({
    obligationId: 'handoff.route-lifecycle',
    version: '1.0.0',
    sourceRefs: ['lifecycle-orchestrator outcomeRoutes', 'REG routing'],
    subjectKind: 'lifecycle-routing-handoff',
    protectedProperty: 'A settled process run routes exactly through its declared outcome route — no unrouted terminal, no invented route.',
    constraints: [
      { kind: 'ordering', field: 'outcomeRoutes' },
      { kind: 'ref', field: 'routeCode', target: 'declared stage outcome' },
    ],
    expectedProtection: { kind: 'transition-handler', logicalId: 'route-lifecycle', version: '1.0.0' },
    faultClasses: ['durable-transition', 'authority-binding'],
    oracleClass: 'mechanical',
    mutationProfile: mp(),
    requiredCorpus: corpus('handoff.route-lifecycle'),
    allowedTerminalKinds: ['failed'],
  }),

  // ---- Documentation check-provider (2026-08-24 admission, ADR-096 §4) ----
  Object.freeze({
    obligationId: 'docs.completeness',
    version: '1.0.0',
    sourceRefs: ['ADR-096 gate item 4', 'NEW-WORKSHOP-DESIGN-AUTHORING-GUIDE §8.4', 'CONVEYOR-MENTAL-MODEL §17'],
    subjectKind: 'documentation-document-submission',
    protectedProperty: 'A documentation document is accepted only when it is the exact single managed submission of the author CandidateSet, structurally valid, and carries every section its document kind requires.',
    constraints: [
      { kind: 'ref', field: 'member.productRef', to: 'managed-node-submission:<id> by id+schema+content_hash' },
      { kind: 'projection', field: 'sections', requires: 'per-kind requiredSections' },
      { kind: 'unique', by: 'section.id' },
    ],
    expectedProtection: { kind: 'check-provider', logicalId: 'factory.documentation-completeness.v1', version: '1.0.0' },
    faultClasses: ['authority-binding', 'contract-shape'],
    oracleClass: 'mechanical',
    mutationProfile: mp(),
    requiredCorpus: corpus('docs.completeness'),
    allowedTerminalKinds: ['repair_required', 'failed'],
  }),

  // ---- Payload contracts ----------------------------------------------------
  ...[
    ['factory.candidate-verification-evidence-product.v2', '2.0.0', 'Verification evidence product pins the exact candidate hash and check receipts.', 'dev.payload.verification-evidence'],
    ['factory.development-implementation-result.v1', '1.3.0', 'Implementation results pin the claimed file surface and commit identity.', 'dev.payload.implementation-result'],
    // 1.2.0 (CC-GAP-7): additive — the manifest contract now also validates
    // the package-declared warrant oracle adapter set (requires a present
    // warrantRef; closed declaration vocabulary).
    ['factory.development-readiness-manifest.v1', '1.2.0', 'The readiness manifest pins toolchain identity, declared surface, and the typed warrant oracle adapter declarations (present warrant required).', 'dev.payload.readiness-manifest'],
    ['factory.development-review-verdict.v1', '1.1.0', 'Development review verdicts pin the reviewed candidate ordinal.', 'dev.payload.review-verdict'],
    ['factory.development-task-graph-proposal.v1', '1.0.0', 'Task graph proposals pin item keys and dependency edges.', 'dev.payload.task-graph-proposal'],
    ['factory.review-verdict.v1', '1.1.0', 'Formalization review verdicts pin the subject candidate set.', 'frm.payload.review-verdict'],
    ['factory.source-change-candidate.v1', '1.0.0', 'Source change candidates pin changed files to the execution worktree.', 'dev.payload.source-change-candidate'],
    ['factory.formalization-reconciliation-report.v1', '1.0.0', 'Reconciliation reports pin the typed WHAT-catchall payload (status/rationale/empty remaining_gaps/repairs).', 'frm.payload.reconciliation-report'],
    ['factory.documentation-document.v1', '1.0.0', 'Documentation documents pin the kind registry, section structure and the exact generated-for candidate.', 'docs.payload.document'],
    ['factory.documentation-review-verdict.v1', '1.0.0', 'Documentation review verdicts pin the exact subject candidate set.', 'docs.payload.review-verdict'],
  ].map(([schemaId, version, property, id]) => Object.freeze({
    obligationId: id,
    version,
    sourceRefs: [`WORKSHOP_PAYLOAD_CONTRACTS ${schemaId}@${version}`, 'ADR-053 Phase 1 parity'],
    subjectKind: 'product-payload-contract',
    protectedProperty: property,
    constraints: [
      { kind: 'equality', field: 'schemaId', value: schemaId },
      { kind: 'version', field: 'contractVersion' },
    ],
    expectedProtection: { kind: 'payload-contract', logicalId: schemaId, version },
    faultClasses: ['contract-shape'],
    oracleClass: 'mechanical',
    mutationProfile: mp(),
    requiredCorpus: corpus(id),
    allowedTerminalKinds: ['repair_required'],
  })),
]);

/** Compiled normative registry: contracts validate + unique obligation ids. */
export function compileNormativeObligations(contracts = ACCEPTANCE_OBLIGATION_CONTRACTS) {
  const errors = [];
  const seen = new Set();
  for (const c of contracts) {
    const v = validateObligationContract(c);
    if (v.length > 0) errors.push(`${c?.obligationId ?? '<anonymous>'}: ${v.join('; ')}`);
    if (seen.has(c.obligationId)) errors.push(`duplicate obligationId ${c.obligationId}`);
    seen.add(c.obligationId);
  }
  if (errors.length > 0) {
    const e = new Error(`OBLIGATION_CONTRACT_INVALID:\n  ${errors.join('\n  ')}`);
    e.code = 'OBLIGATION_CONTRACT_INVALID';
    e.errors = errors;
    throw e;
  }
  return contracts.map(c => Object.freeze({ ...c }));
}
