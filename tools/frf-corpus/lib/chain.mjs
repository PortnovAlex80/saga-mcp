/**
 * tools/frf-corpus/lib/chain.mjs - the FRF desk-chain driver (FRF-WP10).
 *
 * Drives the NEW semantic chain through the cells' TEST-ONLY surfaces -
 * their exported functions only, exactly the way the cells' own focused
 * suites drive them. The corpus NEVER writes kernel storage and never
 * opens a kernel database; the WP03 validators are installed through the
 * documented seams; the WP07 evidence ledger is the only durable seam and
 * is addressed through its public submit() path.
 *
 * Chain (FRF-WP04..09):
 *   define-product-intent  -> model-use-cases -> derive-system-requirements
 *   -> define-acceptance-contract -> reconcile-what (report-only)
 *   -> freeze-what-baseline -> define-architecture-contract
 *   -> settle-formalization -> admit-development-case -> plan-development
 *
 * A typed refusal stops the chain at the owning desk (the first failing
 * desk decides - the conveyor law). The observed world is normalized the
 * EK way: everything semantic, nothing volatile, deterministic order.
 */

import {
  acceptedIdSets,
  architectureUniverseOf,
  clone,
  greenRealizationDraft,
  greenWorkItemInputs,
  prdUniverseOf,
  repositoryPolicyRefsOf,
  srsAuthorityOf,
  acceptedSurfacesOf,
  wireCells,
} from './material.mjs';
import { chainInputsFor } from './mutations.mjs';
import { FrfDurableSession, FrfFaultScheduler } from './faults.mjs';

const refusalOf = (outcome) =>
  outcome !== null && typeof outcome === 'object' && outcome.ok === false && typeof outcome.reason === 'string';

const gateRefusalOf = (outcome) =>
  outcome !== null && typeof outcome === 'object' && outcome.refused === true && typeof outcome.reason === 'string';

/* ------------------------------------------------------------------ */
/* The desk-chain drive (one deterministic pass)                       */
/* ------------------------------------------------------------------ */

/**
 * Drive the desk chain once.
 *
 * @param {object} inputs the (possibly mutated) chain inputs of chainInputsFor()
 * @param {object} options { session?, scheduler?, workItems?, stopAfter? }
 * @returns the run record { desks, artifacts, state }
 */
export async function driveDeskChain(inputs, options = {}) {
  const cells = await wireCells();
  const session = options.session ?? new FrfDurableSession(cells.persistence);
  const scheduler = options.scheduler ?? new FrfFaultScheduler(null);
  const run = {
    desks: [],
    artifacts: {},
    state: {},
    session,
    refusedAt: null,
    waitOpened: null,
    waitDischarged: null,
  };

  const desk = (id) => {
    const entry = { desk: id, status: 'committed', verdict: null, reason: null, outcome: null, detail: null };
    run.desks.push(entry);
    return entry;
  };
  const stop = (entry, reason, detail) => {
    entry.status = 'refused';
    entry.reason = reason;
    entry.detail = detail ?? null;
    run.refusedAt = entry.desk;
    return entry;
  };

  /* 1. define-product-intent */
  scheduler.fire('crash-before-desk', 'define-product-intent');
  {
    const entry = desk('define-product-intent');
    const provider = cells.productIntent.declaredProductIntentCheckProvider();
    const outcome = cells.productIntent.evaluateProductIntentGate(provider, inputs.prd.bundle, prdUniverseOf());
    if (gateRefusalOf(outcome)) { stop(entry, outcome.reason, outcome.detail); }
    else {
      entry.verdict = outcome.verdict ?? null;
      if (outcome.verdict !== 'accepted') { entry.status = 'refused'; entry.reason = outcome.issues?.[0]?.source ?? 'MALFORMED_PRODUCT'; entry.detail = outcome.issues?.[0]?.detail ?? null; run.refusedAt = entry.desk; }
      else { run.state.prdAcceptedSet = outcome.acceptedSet; run.artifacts.prdBundleRef = outcome.productRef; }
    }
  }
  scheduler.fire('crash-after-desk', 'define-product-intent');

  /* 2. model-use-cases */
  if (run.refusedAt === null) {
    scheduler.fire('crash-before-desk', 'model-use-cases');
    const entry = desk('model-use-cases');
    const provider = cells.useCases.declaredUcCheckProvider();
    const outcome = cells.useCases.evaluateUcGate(provider, inputs.uc, run.state.prdAcceptedSet);
    if (gateRefusalOf(outcome)) { stop(entry, outcome.reason, outcome.detail); }
    else {
      entry.verdict = outcome.verdict ?? null;
      if (outcome.verdict !== 'accepted') { entry.status = 'refused'; entry.reason = outcome.issues?.[0]?.source ?? 'MALFORMED_PRODUCT'; entry.detail = outcome.issues?.[0]?.detail ?? null; run.refusedAt = entry.desk; }
      else { run.state.ucAcceptedSet = outcome.acceptedSet; run.artifacts.ucBundleRef = outcome.productRef; }
    }
    scheduler.fire('crash-after-desk', 'model-use-cases');
  }

  /* 3. derive-system-requirements */
  if (run.refusedAt === null) {
    scheduler.fire('crash-before-desk', 'derive-system-requirements');
    const entry = desk('derive-system-requirements');
    const built = cells.systemRequirements.buildRequirementsBundle({
      prdRevisionDigest: inputs.prdRevisionPinOverride ?? inputs.req.deskInput.prd.revisionDigest,
      ucRevisionDigest: inputs.req.deskInput.useCases.revisionDigest,
      requirements: inputs.req.members,
    });
    if (refusalOf(built)) { stop(entry, built.reason, built.detail); }
    else {
      const universeOutcome = cells.systemRequirements.deriveAcceptedUniverse(inputs.req.deskInput);
      if (refusalOf(universeOutcome)) { stop(entry, universeOutcome.reason, universeOutcome.detail); }
      else {
        const declared = cells.systemRequirements.declaredSystemRequirementsProvider();
        if (declared.ok !== true) { stop(entry, 'SCOPE_VIOLATION', declared.detail); }
        else {
          const outcome = cells.systemRequirements.gateSystemRequirementsCandidate(
            declared.provider,
            { kind: cells.systemRequirements.SYSTEM_REQUIREMENTS_PRODUCT_KIND, product: built.sealed.bundle },
            universeOutcome.universe,
            cells.reqBinding,
          );
          if (outcome.refused === true) { stop(entry, 'MALFORMED_PRODUCT', outcome.detail); }
          else {
            entry.verdict = outcome.verdict ?? null;
            if (outcome.verdict !== 'accepted') { entry.status = 'refused'; entry.reason = outcome.issues?.[0]?.source ?? 'MALFORMED_PRODUCT'; entry.detail = outcome.issues?.[0]?.detail ?? null; run.refusedAt = entry.desk; }
            else { run.state.sealedRequirements = built.sealed; run.state.reqUniverse = universeOutcome.universe; run.artifacts.requirementsBundleRef = built.sealed.ref; }
          }
        }
      }
    }
    scheduler.fire('crash-after-desk', 'derive-system-requirements');
  }

  /* 4. define-acceptance-contract */
  if (run.refusedAt === null) {
    scheduler.fire('crash-before-desk', 'define-acceptance-contract');
    const entry = desk('define-acceptance-contract');
    const built = cells.acceptance.acceptanceUniverseFrom(inputs.acceptance.inputs);
    if (built.ok !== true) { stop(entry, built.reason, built.detail); }
    else {
      const outcome = cells.acceptance.evaluateAcceptanceGate(
        { ...cells.acceptance.ACCEPTANCE_CHECK_PROVIDER, providerDigest: cells.acceptance.acceptanceProviderDigest() },
        { kind: cells.acceptance.ACCEPTANCE_CELL_PRODUCT_KIND, product: inputs.acceptance.bundle },
        built.universe,
        inputs.acceptance.inputs.requirementsBundle.requirements,
      );
      if (gateRefusalOf(outcome)) { stop(entry, outcome.reason, outcome.detail); }
      else {
        entry.verdict = outcome.verdict ?? null;
        if (outcome.verdict !== 'accepted') { entry.status = 'refused'; entry.reason = outcome.issues?.[0]?.source ?? 'MALFORMED_PRODUCT'; entry.detail = outcome.issues?.[0]?.detail ?? null; run.refusedAt = entry.desk; }
        else { run.state.acceptanceUniverse = built.universe; run.artifacts.acceptanceBundleRef = outcome.productRef ?? null; }
      }
    }
    scheduler.fire('crash-after-desk', 'define-acceptance-contract');
  }

  /* 5. reconcile-what (report-only; never stops the chain) */
  if (run.refusedAt === null) {
    scheduler.fire('crash-before-desk', 'reconcile-what');
    const entry = desk('reconcile-what');
    const snapshot = options.reconciliationSnapshot ?? defaultReconciliationSnapshot(inputs, run);
    run.state.reconciliationSnapshot = snapshot;
    const report = cells.acceptance.reconcileWhat(snapshot);
    run.state.reconciliationReport = report;
    entry.verdict = report.verdict;
    scheduler.fire('crash-after-desk', 'reconcile-what');
  }

  /* 6. freeze-what-baseline (+ the immutable kernel-evidence commit) */
  if (run.refusedAt === null) {
    scheduler.fire('crash-before-desk', 'freeze-what-baseline');
    const entry = desk('freeze-what-baseline');
    const frozen = cells.freeze.freezeWhatBaseline(inputs.surfaces);
    if (gateRefusalOf(frozen)) { stop(entry, frozen.reason, frozen.detail); }
    else if (frozen.ok !== true || frozen.outcome === undefined) { stop(entry, 'MALFORMED_PRODUCT', 'the freeze desk returned no outcome'); }
    else if (frozen.outcome !== 'frozen') {
      entry.outcome = frozen.outcome;
      entry.status = 'wait';
      entry.reason = frozen.refusal?.reason ?? 'MISSING_LINEAGE';
      entry.detail = frozen.refusal?.detail ?? null;
      run.waitOpened = frozen.wait ?? null;
      run.state.freezeWait = frozen.wait ?? null;
      run.state.freezeRefusal = frozen.refusal ?? null;
      run.refusedAt = entry.desk; // the chain pauses at the wait (the D5/D12 resume point)
    } else {
      entry.outcome = 'frozen';
      run.state.frozen = frozen;
      run.artifacts.whatBaselineArtifact = { digest: frozen.artifact.digest, kind: 'KernelEvidence:what-baseline' };
      const caseRef = frozen.baseline.caseIdentity.formalizationCaseRef;
      scheduler.fire('crash-before-evidence-commit', 'freeze-what-baseline');
      const receipt = session.submitEvidence('KernelEvidence:what-baseline', caseRef, frozen.artifact);
      if (receipt.ok !== true) { stop(entry, receipt.reason, receipt.detail); }
      else { run.artifacts.whatBaselineReceipt = receipt.receiptDigest; }
      scheduler.fire('crash-after-evidence-commit', 'freeze-what-baseline');
    }
    scheduler.fire('crash-after-desk', 'freeze-what-baseline');
  }

  /* 6b. The D5 wait disposition (the scripted actor through the public command path). */
  if (run.waitOpened !== null && run.waitOpened.kind === 'TypedWait:human-input' && options.actorDisposition !== false) {
    scheduler.fire('crash-before-wait-disposition', 'd5-human-wait');
    const wake = {
      command: 'workplace.resolveHumanResponse',
      evidenceRef: 'evidence:HumanResponse#accepted-dispositions-surface',
    };
    run.waitDischarged = cells.persistence.dischargeIndeterminateWait(run.waitOpened, wake);
    scheduler.fire('crash-after-wait-disposition', 'd5-human-wait');
  }

  /* 6c. Re-freeze on the completed surfaces (the actor supplied the missing material). */
  if (run.waitDischarged !== null && run.waitDischarged.ok === true && options.refreezeSurfaces !== undefined) {
    scheduler.fire('crash-before-desk', 'freeze-what-baseline');
    const entry = desk('freeze-what-baseline');
    const frozen = cells.freeze.freezeWhatBaseline(options.refreezeSurfaces);
    if (frozen.ok === true && frozen.outcome === 'frozen') {
      entry.outcome = 'frozen';
      run.state.frozen = frozen;
      run.artifacts.whatBaselineArtifact = { digest: frozen.artifact.digest, kind: 'KernelEvidence:what-baseline' };
      const caseRef = frozen.baseline.caseIdentity.formalizationCaseRef;
      scheduler.fire('crash-before-evidence-commit', 'freeze-what-baseline');
      const receipt = session.submitEvidence('KernelEvidence:what-baseline', caseRef, frozen.artifact);
      if (receipt.ok === true) {
        run.artifacts.whatBaselineReceipt = receipt.receiptDigest;
        run.refusedAt = null; // the wait was discharged and the desk completed: the flow resumes
      } else {
        entry.status = 'refused';
        entry.reason = receipt.reason;
        run.refusedAt = 'freeze-what-baseline';
      }
      scheduler.fire('crash-after-evidence-commit', 'freeze-what-baseline');
    } else {
      entry.status = 'refused';
      entry.reason = frozen.reason ?? 'MALFORMED_PRODUCT';
      run.refusedAt = 'freeze-what-baseline';
    }
    scheduler.fire('crash-after-desk', 'freeze-what-baseline');
  }

  /* 7. define-architecture-contract */
  if (run.refusedAt === null && run.state.frozen !== undefined) {
    scheduler.fire('crash-before-desk', 'define-architecture-contract');
    const entry = desk('define-architecture-contract');
    const srs = srsAuthorityOf();
    const universe = architectureUniverseOf(run.state.frozen, srs);
    const draft = options.realizationDraft ?? greenRealizationDraft();
    draft.lineage.baselineRef = `sha256:${universe.revisionPins.whatBaselineDigest}`;
    const assembly = cells.srsRealization.authorArchitectureContract(draft, universe);
    if (refusalOf(assembly)) { stop(entry, assembly.reason, assembly.detail); }
    else { entry.verdict = 'accepted'; run.state.architectureContract = assembly.product; run.artifacts.architectureContractDigest = assembly.product.canonicalDigest; }
    scheduler.fire('crash-after-desk', 'define-architecture-contract');
  }

  /* 8. settle-formalization (+ the immutable kernel-evidence commit) */
  if (run.refusedAt === null && run.state.architectureContract !== undefined) {
    scheduler.fire('crash-before-desk', 'settle-formalization');
    const entry = desk('settle-formalization');
    const srs = srsAuthorityOf();
    const settled = cells.settlement.settleSolutionContract({
      frozenBaseline: run.state.frozen.baseline,
      baselineArtifact: run.state.frozen.artifact,
      srs,
      repositoryPolicyRefs: repositoryPolicyRefsOf(),
      handoff: inputs.handoff,
    });
    if (gateRefusalOf(settled)) { stop(entry, settled.reason, settled.detail); }
    else if (settled.ok !== true || settled.outcome !== 'formalized') {
      entry.outcome = settled.outcome ?? null;
      entry.status = 'refused';
      entry.reason = settled.refusal?.reason ?? 'MALFORMED_PRODUCT';
      entry.detail = settled.refusal?.detail ?? null;
      run.refusedAt = entry.desk;
    } else {
      entry.outcome = 'formalized';
      run.state.settled = settled;
      run.artifacts.solutionContractDigest = settled.contract.canonicalDigest;
      const caseRef = run.state.frozen.baseline.caseIdentity.formalizationCaseRef;
      const artifact = settled.artifact;
      scheduler.fire('crash-before-evidence-commit', 'settle-formalization');
      const receipt = session.submitEvidence('KernelEvidence:solution-contract', caseRef, artifact);
      if (receipt.ok !== true) { stop(entry, receipt.reason, receipt.detail); }
      else { run.artifacts.solutionContractReceipt = receipt.receiptDigest; }
      scheduler.fire('crash-after-evidence-commit', 'settle-formalization');
    }
    scheduler.fire('crash-after-desk', 'settle-formalization');
  }

  /* 9. admit-development-case */
  if (run.refusedAt === null && run.state.settled !== undefined) {
    scheduler.fire('crash-before-desk', 'admit-development-case');
    const entry = desk('admit-development-case');
    const srs = srsAuthorityOf();
    const built = cells.caseDesk.buildDevelopmentCase({
      frozenBaseline: run.state.frozen.baseline,
      baselineArtifact: run.state.frozen.artifact,
      srs,
      repositoryPolicyRefs: repositoryPolicyRefsOf(),
      solutionContract: run.state.settled.contract,
      architectureContract: run.state.architectureContract,
    });
    if (refusalOf(built)) { stop(entry, built.reason, built.detail); }
    else { entry.outcome = 'admitted'; run.state.developmentCase = built.developmentCase; run.artifacts.developmentCaseDigest = built.artifact.digest; }
    scheduler.fire('crash-after-desk', 'admit-development-case');
  }

  /* 10. plan-development */
  if (run.refusedAt === null && run.state.developmentCase !== undefined) {
    scheduler.fire('crash-before-desk', 'plan-development');
    const entry = desk('plan-development');
    const inputsRaw = options.workItemInputs ?? greenWorkItemInputs();
    const workItems = [];
    for (const item of inputsRaw) {
      const built = cells.workitemDesk.buildWorkItem(item);
      if (refusalOf(built)) { stop(entry, built.reason, built.detail); break; }
      workItems.push(built.workItem);
    }
    if (entry.status === 'committed') {
      const planned = cells.planDesk.planDevelopment(run.state.developmentCase, workItems);
      if (refusalOf(planned)) { stop(entry, planned.reason, planned.detail); }
      else { entry.outcome = 'planned'; run.state.plan = planned; run.state.workItems = workItems; run.artifacts.planDigest = planned.plan.planDigest; }
    }
    scheduler.fire('crash-after-desk', 'plan-development');
  }

  return run;
}

/** The green reconciliation snapshot over the accepted chain state. */
function defaultReconciliationSnapshot(inputs, run) {
  const sets = acceptedIdSets();
  const claimToMember = {};
  for (const member of inputs.prd.bundle.members) {
    for (const ref of member.sourceClaimRefs ?? []) claimToMember[ref] = member.memberId;
  }
  return {
    universe: run.state.acceptanceUniverse,
    requirements: inputs.acceptance.inputs.requirementsBundle.requirements,
    acceptance: {
      criteria: inputs.acceptance.bundle.criteria,
      deferrals: inputs.acceptance.bundle.deferrals,
      standaloneEvidenceBindings: inputs.acceptance.bundle.standaloneEvidenceBindings,
    },
    prd: {
      memberIds: run.state.prdAcceptedSet?.prdMemberIds ?? [],
      scenarioRequiredMemberIds: run.state.prdAcceptedSet?.scenarioRequiredMemberIds ?? [],
    },
    useCases: {
      scenarioIds: run.state.ucAcceptedSet?.scenarioIds ?? sets.ucScenarioIds,
      branchIdsByScenario: sets.ucBranchIdsByScenario,
    },
    sourceClaims: { claimIds: sets.sourceClaimIds, claimToMember },
  };
}

/* ------------------------------------------------------------------ */
/* The normalized observed world                                       */
/* ------------------------------------------------------------------ */

/**
 * The normalized durable world of one chain run: everything semantic,
 * nothing volatile, deterministic order. Two runs (faulted + restarted
 * vs clean) settling to identical logical outcomes produce identical
 * snapshots - the scenario-level exactly-once proof.
 */
export function normalizedWorldOf(run) {
  const desks = run.desks.map((entry) => ({
    desk: entry.desk,
    status: entry.status,
    ...(entry.verdict !== null ? { verdict: entry.verdict } : {}),
    ...(entry.outcome !== null ? { outcome: entry.outcome } : {}),
    ...(entry.reason !== null ? { reason: entry.reason } : {}),
  }));
  const report = run.state.reconciliationReport;
  const settled = run.state.settled;
  const devCase = run.state.developmentCase;
  const bindingDomains = [];
  if (settled !== undefined) {
    for (const [kind, entry] of Object.entries(settled.contract.developmentHandoff)) {
      bindingDomains.push({ ids: [...entry.values].sort(), kind });
    }
    bindingDomains.sort((a, b) => (a.kind < b.kind ? -1 : 1));
  }
  const waits = [];
  if (run.waitOpened !== null) {
    waits.push({ kind: run.waitOpened.kind, state: run.waitDischarged?.ok === true ? 'discharged' : 'pending' });
  }
  return {
    desks,
    refusals: run.desks.filter((entry) => entry.status === 'refused').map((entry) => ({ reason: entry.reason, target: entry.desk })),
    bindingDomains,
    ...(report !== undefined ? { closure: { gapReasons: [...new Set(report.gaps.map((gap) => gap.reason))].sort(), verdict: report.verdict } } : {}),
    waits,
    terminal: {
      developmentCase: devCase !== undefined ? 'admitted' : (run.refusedAt === 'admit-development-case' ? 'refused' : 'not-reached'),
      plan: run.state.plan !== undefined ? 'planned' : (run.refusedAt === 'plan-development' ? 'refused' : 'not-reached'),
      replan: run.state.replanOutcome ?? 'not-reached',
    },
    capsule: capsuleReceiptOf(run),
    evidence: run.session.rows.map((row) => row.actionKey).sort(),
    receiptDigests: run.session.rows.map((row) => row.receiptDigest).sort(),
  };
}

/**
 * The capsule receipt: every content-addressed artifact the flow sealed
 * through public ingress (deterministic digests; the determinism suite
 * pins them across runs).
 */
export function capsuleReceiptOf(run) {
  const artifacts = [];
  const push = (kind, digest) => { if (typeof digest === 'string') artifacts.push({ digest, kind }); };
  push('frf-cell.product-intent.v1', run.artifacts.prdBundleRef?.replace(/^sha256:/, ''));
  push('frf-cell.uc-scenarios.v1', run.artifacts.ucBundleRef?.replace(/^sha256:/, ''));
  push('frf-contracts.requirements-bundle.v1', run.artifacts.requirementsBundleRef?.replace(/^sha256:/, ''));
  push('formalization.acceptance-bindings.v1', run.artifacts.acceptanceBundleRef?.replace(/^sha256:/, ''));
  if (run.state.reconciliationReport !== undefined) push('formalization.what-reconciliation.v1', run.state.reconciliationReport.reportDigest.replace(/^sha256:/, ''));
  push('KernelEvidence:what-baseline', run.artifacts.whatBaselineArtifact?.digest);
  push('formalization.architecture-contract.v1', run.artifacts.architectureContractDigest);
  push('frf-contracts.solution-contract.v1', run.artifacts.solutionContractDigest);
  push('frf-development.case.v1', run.artifacts.developmentCaseDigest);
  push('frf-development.plan.v1', run.artifacts.planDigest);
  return { artifacts: artifacts.sort((a, b) => (a.kind < b.kind ? -1 : 1)) };
}

/** Green chain inputs (fresh clones; never the frozen fixture objects). */
export const greenChainInputs = () => chainInputsFor(null);
export { clone };
