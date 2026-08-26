/**
 * installation.test.mjs - WP-11V deliverable 1: the workshop semantic
 * interface validates as pure data over the frozen kernel - identity,
 * product schemas, installed skills/tools/hooks, CheckPlans, gates (with
 * the EXACT frozen verdict vocabulary), idempotent effects (with the EXACT
 * frozen D2 outcome set) and typed D5/D12 waits (frozen kinds, frozen wake
 * sources). Product round-trips and the pure contribution mappings are
 * exercised with their typed refusals.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { scenarioConfig, sha256, CAPSULE_BYTES } from './support.mjs';

const installation = await import('../../../../dist/workflow-kernel/workshops/development/installation.js');
const manifest = await import('../../../../dist/workflow-kernel/workshops/development/manifest.js');
const products = await import('../../../../dist/workflow-kernel/workshops/development/products.js');
const mappings = await import('../../../../dist/workflow-kernel/workshops/development/mappings.js');
const checkplans = await import('../../../../dist/workflow-kernel/workshops/development/checkplans.js');
const runbook = await import('../../../../dist/workflow-kernel/workshops/development/runbook.js');
const waits = await import('../../../../dist/workflow-kernel/workshops/development/waits.js');
const effects = await import('../../../../dist/workflow-kernel/workshops/development/effects.js');
const universe = await import('../../../../dist/workflow-kernel/domain/universe.js');

test('the installed workshop validates as pure data over the frozen kernel', () => {
  const value = manifest.developmentWorkshopInstallation();
  const validated = installation.validateWorkshopInstallation(value);
  assert.equal(validated.valid, true, JSON.stringify(validated));
  // Identity: module/package identity is manifest data, never a kernel conditional.
  assert.equal(value.identity.workshopId, 'workshop:development');
  assert.ok(value.identity.processModuleRef.startsWith('content://process-modules/'));
  // The lifecycle family class is READ from the frozen manifest (never a source literal).
  assert.equal(typeof value.identity.workshopClass, 'string');
  assert.ok(value.identity.workshopClass.length > 0);
});

test('the product schemas cover the workshop phases: review input, certification input, verified output', () => {
  const schemas = manifest.developmentProductSchemas();
  const ids = schemas.map((schema) => schema.schemaId);
  assert.deepEqual(ids, [
    'workshop.development.integrated-candidate.v1',
    'workshop.development.review-verdict-payload.v1',
    'workshop.development.readiness-manifest.v1',
    'workshop.development.verified-bundle.v1',
  ]);
  assert.deepEqual(schemas.map((schema) => schema.role), ['input', 'input', 'input', 'output']);
});

test('installed skills, tools and hooks are content-addressed manifest data', () => {
  const installed = manifest.developmentWorkshopInstallation().installed;
  for (const skill of installed.skills) {
    assert.match(skill.instructionsRef, /^sha256:[0-9a-f]{64}$/);
    assert.match(skill.digest, /^[0-9a-f]{64}$/);
  }
  assert.ok(installed.tools.length >= 3);
  for (const hook of installed.hooks) {
    assert.match(hook.additionalContextRef, /^sha256:[0-9a-f]{64}$/);
  }
});

test('the gate verdict vocabulary is DERIVED from the frozen evidence registry (the frozen five)', () => {
  const verdicts = installation.gateVerdictVocabulary();
  assert.deepEqual([...verdicts].sort(), ['accepted', 'human-wait', 'repair', 'terminal-reject', 'upstream-repair']);
  for (const gate of checkplans.developmentGateDeclarations()) {
    assert.deepEqual([...gate.verdictVocabulary].sort(), [...verdicts].sort(), `${gate.gateId} restates the frozen five exactly`);
  }
});

test('the effect outcome vocabulary is DERIVED from the frozen registry (the D2 seven)', () => {
  const outcomes = installation.effectOutcomeVocabulary();
  assert.deepEqual([...outcomes].sort(), ['already-applied', 'human-wait', 'policy-terminal', 'repair', 'retryable', 'success', 'unknown']);
  const effect = effects.developmentEffectDeclaration();
  assert.deepEqual([...effect.outcomes].sort(), [...outcomes].sort());
  assert.equal(effect.idempotentResumeOutcome, 'already-applied');
  assert.equal(effect.verificationEvidenceKind, 'ProductVerificationEvidence');
});

test('the installed CheckPlan rows are content-addressed and feed the kernel gate guards (R15)', () => {
  const rows = checkplans.developmentCheckPlanRows();
  assert.ok(rows.length >= 5);
  const evidence = checkplans.developmentCheckPlanEvidence();
  assert.equal(evidence.length, rows.length);
  for (const fact of evidence) {
    assert.equal(fact.kind, 'CheckPlan');
    assert.equal(fact.producer, 'external-input', 'the ledger admits external Input authority evidence under this exact producer');
    assert.match(fact.ref, /^checkplan:development\./);
    assert.match(fact.payloadDigest, /^[0-9a-f]{64}$/);
  }
  // The operator-only check exists and belongs to the certification gate.
  const operatorRow = rows.find((row) => row.evaluator === 'operator');
  assert.equal(operatorRow.gate, 'development.certification');
});

test('the typed waits are frozen kinds with frozen wake sources (D5/D12 only)', () => {
  const declarations = waits.developmentWaitDeclarations();
  assert.equal(declarations.length, 2);
  const registry = new Map(universe.WAITS.map((wait) => [wait.kind, wait]));
  for (const declaration of declarations) {
    const row = registry.get(declaration.kind);
    assert.ok(row, `${declaration.purpose} names a frozen wait kind`);
    for (const wake of declaration.wakeCommands) {
      assert.ok(row.wakeCommands.includes(wake), `${declaration.purpose}: ${wake} is a declared wake source of ${declaration.kind}`);
    }
    assert.equal(declaration.operatorDispositionRequired, true, 'both installed waits are operator-disposition waits');
  }
});

test('products: round-trip validation and typed refusals', () => {
  const capsuleRef = 'sha256:' + sha256('capsule');
  const candidate = {
    schemaId: 'workshop.development.integrated-candidate.v1',
    capsuleRef,
    productDigest: sha256('product'),
    scopeRefs: ['content://requirements/1'],
    toolCallDigest: sha256('tools'),
    summary: 'the integrated candidate',
  };
  assert.equal(products.validateIntegratedCandidate(candidate).valid, true);
  assert.match(products.integratedCandidateDigest(candidate), /^[0-9a-f]{64}$/);

  // Typed refusals: malformed shapes never pass.
  assert.equal(products.validateIntegratedCandidate({ ...candidate, productDigest: 'zzz' }).refused, true);
  assert.equal(products.validateIntegratedCandidate({ ...candidate, scopeRefs: [] }).refused, true);

  const readiness = {
    schemaId: 'workshop.development.readiness-manifest.v1',
    capsuleRef,
    workplaceInstanceId: 'workplace:1',
    machineObservation: 'product-verified',
    verificationDigest: sha256('verified'),
    settledEvidenceKinds: ['EffectReceipt:human-wait'],
    unobservable: 'readiness-for-certification',
    requiredDisposition: { kind: 'TypedWait:human-input', wakeCommand: 'workplace.resolveHumanResponse', operatorDispositionRequired: true },
  };
  assert.equal(products.validateReadinessManifest(readiness).valid, true);
  assert.equal(products.validateReadinessManifest({ ...readiness, machineObservation: 'machine-certified' }).refused, true);

  const bundle = {
    schemaId: 'workshop.development.verified-bundle.v1',
    capsuleRef,
    workplaceInstanceId: 'workplace:1',
    acceptanceDigest: sha256('acceptance'),
    terminalProofs: ['TerminalProof:run.success'],
    claimCoverageRefs: ['evidence:TerminalClaimCoverage#1'],
    runTerminalOutcome: 'success',
  };
  assert.equal(products.validateVerifiedBundle(bundle).valid, true);
  assert.equal(products.validateVerifiedBundle({ ...bundle, terminalProofs: ['not-a-proof'] }).refused, true);
});

test('mappings: pure contribution mappings with typed refusals', async () => {
  const actorResult = {
    attemptRef: 'activity-attempt:1',
    requestCount: 1,
    receipts: [],
    toolCalls: [{ name: 'run-command', args: ['npm run build'] }],
    text: ['built the product'],
    products: [{ digest: sha256('simple-server-product-v1'), description: 'server.js + public/*' }],
    outcomeDigest: 'sha256:' + sha256('outcome'),
  };
  const capsuleRef = 'sha256:' + sha256('capsule');
  const mapped = mappings.toIntegratedCandidate(actorResult, { capsuleRef, scopeRefs: ['content://requirements/1'] });
  assert.equal(mapped.mapped, true);
  assert.equal(mapped.value.productDigest, sha256('simple-server-product-v1'));
  assert.match(mapped.digest, /^[0-9a-f]{64}$/);

  // Empty contributions are refused: an actor without a product is not a candidate.
  const empty = mappings.toIntegratedCandidate({ ...actorResult, products: [] }, { capsuleRef, scopeRefs: ['content://requirements/1'] });
  assert.equal(empty.refused, true);
  assert.equal(empty.code, 'ACTOR_PRODUCED_NO_PRODUCT');

  // The reviewer payload mapping carries the surfaced verdict for the declared rules (never trusted raw).
  const reviewer = mappings.toReviewerGateInput({ ...actorResult, verdict: 'accepted' }, { capsuleRef });
  assert.equal(reviewer.mapped, true);
  assert.equal(reviewer.value.surfacedVerdict, 'accepted');
});

test('the semantic gate evaluator walks the declared rules only (no default verdict)', () => {
  const gates = new Map(checkplans.developmentGateDeclarations().map((gate) => [gate.gateId, gate]));
  const final = gates.get('development.final');
  assert.equal(checkplans.evaluateSemanticGate(final, [
    { checkId: 'development.check.verification-evidence', outcome: 'pass' },
  ]).verdict, 'accepted');
  assert.equal(checkplans.evaluateSemanticGate(final, [
    { checkId: 'development.check.verification-evidence', outcome: 'fail' },
  ]).verdict, 'terminal-reject');

  // Unknown check -> typed refusal; undecided results -> typed refusal (never a default).
  assert.equal(checkplans.evaluateSemanticGate(final, [{ checkId: 'development.check.not-installed', outcome: 'pass' }]).refused, true);
  assert.equal(checkplans.evaluateSemanticGate(gates.get('development.author'), [{ checkId: 'development.check.scope-coverage', outcome: 'operator-only' }]).refused, true);

  // The certification gate: operator-only readiness always decides human-wait (Elite-2).
  const certification = runbook.certificationGateDecision();
  assert.equal(certification.decided, true);
  assert.equal(certification.verdict, 'human-wait');
});

test('the operator disposition receipt is content-addressed and verifies fail-closed', () => {
  const receipt = waits.buildOperatorDisposition({
    operatorId: 'operator:ek-wp11v',
    readinessManifestDigest: sha256('readiness'),
    decision: 'readiness-certified',
    note: 'certified from the freeze report',
  });
  assert.equal(waits.verifyOperatorDisposition(receipt).verified, true);
  const tampered = { ...receipt, note: 'tampered' };
  assert.equal(waits.verifyOperatorDisposition(tampered).verified, false);
});

test('installation-level validation refusals: every kernel-facing drift is typed', () => {
  const base = manifest.developmentWorkshopInstallation();
  // Wait-kind invention.
  const inventedWait = structuredClone(base);
  inventedWait.waits = [...base.waits, { purpose: 'operator-mood', kind: 'TypedWait:operator-mood', wakeCommands: ['workplace.resolveHumanResponse'], operatorDispositionRequired: false, rationale: 'invented' }];
  const waitRefusal = installation.validateWorkshopInstallation(inventedWait);
  assert.equal(waitRefusal.refused, true);
  assert.equal(waitRefusal.code, 'WAIT_KIND_OUTSIDE_UNIVERSE');
  // Wake source outside the frozen registry row.
  const inventedWake = structuredClone(base);
  inventedWake.waits = [{ ...base.waits[0], wakeCommands: ['factoryRun.resume'] }];
  assert.equal(installation.validateWorkshopInstallation(inventedWake).code, 'WAIT_WAKE_COMMAND_OUTSIDE_REGISTRY');
  // Gate verdict vocabulary drift.
  const driftedVocabulary = structuredClone(base);
  driftedVocabulary.gates = base.gates.map((gate, index) => index === 0 ? { ...gate, verdictVocabulary: ['accepted'] } : gate);
  assert.equal(installation.validateWorkshopInstallation(driftedVocabulary).code, 'GATE_VERDICT_VOCABULARY_DRIFT');
  // Effect outcome drift.
  const driftedOutcomes = structuredClone(base);
  driftedOutcomes.effects = base.effects.map((effect) => ({ ...effect, outcomes: ['success'] }));
  assert.equal(installation.validateWorkshopInstallation(driftedOutcomes).code, 'EFFECT_OUTCOME_VOCABULARY_DRIFT');
  // Obligation-kind invention is refused.
  const obligations = installation.assertObligationKindsInstalled(['obligation:renderReportPage'], 'mutation');
  assert.equal(obligations.refused, true);
  assert.equal(obligations.code, 'OBLIGATION_KIND_OUTSIDE_UNIVERSE');
  assert.equal(installation.assertObligationKindsInstalled(['obligation:submitContribution'], 'ok').ok, true);
});

test('the scenario config builds over the same WP-08 fixtures (import-only reuse)', async () => {
  const { config, capsule, packageBytes } = await scenarioConfig();
  assert.equal(config.session !== undefined, true);
  assert.equal(capsule.schemaVersion, 'ek.discovery-formalization-capsule.ek5.v1');
  assert.ok(packageBytes.byteLength > 0);
  config.session.close();
});
