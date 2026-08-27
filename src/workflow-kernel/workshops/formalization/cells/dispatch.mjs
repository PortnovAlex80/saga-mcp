/**
 * workflow-kernel/workshops/formalization/cells/dispatch.mjs - THE
 * INSTALLED SEMANTIC DISPATCH of the Formalization workshop (FRF-WP11
 * cutover; plan phase FRF-10 "Cut production Formalization to the new
 * package and graph in one controlled landing").
 *
 * THE CUTOVER LAW this module implements:
 *   - The installed desks route through the FRF CELLS (WP04-09). The
 *     old products.ts desk validators - the folded what-baseline shape,
 *     the hardcoded-consistent reconciliation, the binding-blind
 *     settlement - are DELETED (no forwarding facade, no dual path).
 *   - Each desk's universe is DERIVED from the accepted chain (the
 *     cross-desk lineage fold) exactly the way the FRF scenario corpus
 *     drives the same cells: fail-closed, never a scan, never a guess.
 *   - Authored desk inputs (the WP03 member bundles, the freeze
 *     surfaces, the SRS draft + revision pin, the twelve-kind handoff)
 *     arrive on the candidate - the exact material carried by the
 *     transition; the dispatch never re-derives authored content.
 *
 * THE ACCEPTED CHAIN (the ADR-053 material authority, successor of the
 * deleted contribution.ts fold): one immutable state object folded
 * forward only on an ACCEPTED author gate - handoff -> prd -> useCases
 * -> requirements -> acceptance -> reconciliation -> baseline -> srs ->
 * solution. Every downstream desk validates against the EXACT accepted
 * sets; the attempt is provenance, never authority.
 *
 * PURITY: pure functions over the cells' pure surfaces. No session, no
 * SQL, no clock, no filesystem, no network.
 */

import * as productIntent from './product-intent/index.js';
import * as useCases from './use-cases/index.js';
import * as systemRequirements from './system-requirements/index.js';
import * as srsRealization from './srs-realization/index.js';
import * as acceptance from './acceptance/index.mjs';
import * as whatFreeze from './what-freeze/freeze.mjs';
import * as whatFreezeProtocol from './what-freeze/protocol.mjs';
import * as whatFreezeSettlement from './what-freeze/settlement.mjs';

/* ------------------------------------------------------------------ */
/* The accepted chain (the material-authority fold)                     */
/* ------------------------------------------------------------------ */

/** The initial accepted chain of an imported Discovery handoff. */
export function acceptedChainOfHandoff(handoff) {
  if (handoff === null || typeof handoff !== 'object' || !Array.isArray(handoff.sourceClaimIds)) {
    throw new Error('FORMALIZATION_CHAIN: the accepted chain seeds from the imported Discovery handoff (fail-closed)');
  }
  return {
    handoff: {
      digest: handoff.digest,
      sourceClaimIds: [...handoff.sourceClaimIds],
      constraintIds: [...(handoff.constraintIds ?? [])],
      unknownIds: [...(handoff.unknownIds ?? [])],
      terminalClaimIds: [...(handoff.terminalClaimIds ?? [])],
    },
  };
}

/** Fold one desk's ACCEPTED gate outcome into the chain (pure). */
export function foldDeskAcceptance(chain, nodeId, fold) {
  if (fold === null || typeof fold !== 'object') return chain;
  switch (nodeId) {
    case 'define-product-intent':
      return { ...chain, prd: { acceptedSet: fold.acceptedSet, bundle: fold.bundle } };
    case 'model-use-cases':
      return { ...chain, useCases: { acceptedSet: fold.acceptedSet, bundle: fold.bundle } };
    case 'derive-system-requirements':
      return { ...chain, requirements: { sealed: fold.sealed, universe: fold.universe } };
    case 'define-acceptance-contract':
      return { ...chain, acceptance: { universe: fold.universe, bundle: fold.bundle } };
    case 'reconcile-what':
      return { ...chain, reconciliation: { report: fold.report } };
    case 'freeze-what-baseline':
      return { ...chain, baseline: { baseline: fold.baseline, artifact: fold.artifact } };
    case 'define-architecture-contract':
      return { ...chain, srs: { architectureContract: fold.architectureContract, srsAuthority: fold.srsAuthority } };
    case 'settle-formalization':
      return { ...chain, solution: { contract: fold.contract, artifact: fold.artifact, repositoryPolicyRefs: [...(fold.repositoryPolicyRefs ?? [])] } };
    default:
      return chain;
  }
}

/* ------------------------------------------------------------------ */
/* Universe derivations (fail-closed; exact accepted sets only)         */
/* ------------------------------------------------------------------ */

/** Route one typed product refusal to the desk verdict (the cells' frozen routing: FOREIGN belongs upstream; the rest repairs the author). */
const routedRefusal = (providerId, refusal) => ({
  verdict: refusal.reason === 'FOREIGN_LINEAGE' ? 'upstream-repair' : refusal.reason === 'SCOPE_VIOLATION' ? 'terminal-reject' : 'repair',
  issues: [{ source: refusal.reason, detail: refusal.detail }],
  providerId,
});

const required = (chain, field, detail) => {
  const value = chain[field];
  if (value === undefined || value === null) {
    return { ok: false, refused: true, reason: 'MISSING_LINEAGE', detail };
  }
  return { ok: true, value };
};

/* ------------------------------------------------------------------ */
/* The per-desk dispatch                                                */
/* ------------------------------------------------------------------ */

/** evaluateDeskCandidate(deskId, candidate, chain) - the one installed gate entry. */
export function evaluateDeskCandidate(deskId, candidate, chain) {
  if (candidate === null || typeof candidate !== 'object') {
    return { ok: false, refused: true, reason: 'PRODUCT_KIND_MISMATCH', detail: `desk ${deskId} was handed no candidate (fail-closed)` };
  }
  switch (deskId) {
    /* 1. define-product-intent: every member through the WP03 seam. */
    case 'define-product-intent': {
      const universe = { idSets: { sourceClaimIds: chain.handoff.sourceClaimIds, terminalClaimIds: chain.handoff.terminalClaimIds } };
      const outcome = productIntent.evaluateProductIntentGate(productIntent.declaredProductIntentCheckProvider(), candidate.product, universe);
      if (outcome.refused === true) return { ok: false, refused: true, reason: outcome.reason, detail: outcome.detail };
      if (outcome.verdict !== 'accepted') {
        return { verdict: outcome.verdict, issues: outcome.issues ?? [], providerId: outcome.providerId };
      }
      return {
        verdict: 'accepted',
        issues: [],
        providerId: outcome.providerId,
        productRef: outcome.productRef,
        fold: { kind: 'prd', bundle: candidate.product, acceptedSet: outcome.acceptedSet },
      };
    }

    /* 2. model-use-cases: scenarios against the accepted PRD intent set. */
    case 'model-use-cases': {
      const prd = required(chain, 'prd', 'no accepted define-product-intent set is in the chain; the UC desk models scenarios against the exact accepted PRD members only');
      if (prd.ok !== true) return prd;
      const outcome = useCases.evaluateUcGate(useCases.declaredUcCheckProvider(), candidate.product, prd.value.acceptedSet);
      if (outcome.refused === true) return { ok: false, refused: true, reason: outcome.reason, detail: outcome.detail };
      if (outcome.verdict !== 'accepted') {
        return { verdict: outcome.verdict, issues: outcome.issues ?? [], providerId: outcome.providerId };
      }
      return {
        verdict: 'accepted',
        issues: [],
        providerId: outcome.providerId,
        productRef: outcome.productRef,
        fold: { kind: 'uc', bundle: candidate.product, acceptedSet: outcome.acceptedSet },
      };
    }

    /* 3. derive-system-requirements: the WP03 bundle over the exact pins. */
    case 'derive-system-requirements': {
      const prd = required(chain, 'prd', 'no accepted PRD revision is in the chain; requirements derive only from accepted PRD and UC material');
      if (prd.ok !== true) return prd;
      const uc = required(chain, 'useCases', 'no accepted UC revision is in the chain; requirements derive only from accepted PRD and UC material');
      if (uc.ok !== true) return uc;
      const deskInput = {
        prd: { revisionDigest: prd.value.acceptedSet.revisionDigest, memberIds: [...prd.value.acceptedSet.prdMemberIds] },
        useCases: {
          revisionDigest: uc.value.acceptedSet.revisionDigest,
          scenarioIds: [...uc.value.acceptedSet.scenarioIds],
          branchIdsByScenario: { ...uc.value.acceptedSet.branchIdsByScenario },
        },
        sourceConstraintIds: [...chain.handoff.constraintIds],
        verificationSurfaceIds: [...(candidate.deskInput?.verificationSurfaceIds ?? [])],
      };
      const built = systemRequirements.buildRequirementsBundle({
        prdRevisionDigest: deskInput.prd.revisionDigest,
        ucRevisionDigest: deskInput.useCases.revisionDigest,
        requirements: candidate.product,
      });
      if (built.ok !== true) return routedRefusal('formalization.requirements-structure.v1', built);
      const universeOutcome = systemRequirements.deriveAcceptedUniverse(deskInput);
      if (universeOutcome.ok !== true) return routedRefusal('formalization.requirements-structure.v1', universeOutcome);
      const declared = systemRequirements.declaredSystemRequirementsProvider();
      if (declared.ok !== true) return { ok: false, refused: true, reason: 'PROVIDER_NOT_DECLARED', detail: declared.detail };
      const gated = systemRequirements.gateSystemRequirementsCandidate(
        declared.provider,
        { kind: systemRequirements.SYSTEM_REQUIREMENTS_PRODUCT_KIND, product: built.sealed.bundle },
        universeOutcome.universe,
        installedRequirementsSeamBinding(),
      );
      if (gated.refused === true) return { ok: false, refused: true, reason: 'PROVIDER_NOT_DECLARED', detail: gated.detail };
      if (gated.verdict !== 'accepted') {
        return { verdict: gated.verdict, issues: gated.issues.map((issue) => ({ source: issue.source, detail: issue.detail })), providerId: declared.provider.providerId };
      }
      return {
        verdict: 'accepted',
        issues: [],
        providerId: declared.provider.providerId,
        productRef: built.sealed.ref,
        fold: { kind: 'requirements', sealed: built.sealed, universe: universeOutcome.universe },
      };
    }

    /* 4. define-acceptance-contract: closure + bindings over the accepted sets. */
    case 'define-acceptance-contract': {
      const req = required(chain, 'requirements', 'acceptance criteria derive only from accepted requirements and UC material');
      if (req.ok !== true) return req;
      const uc = required(chain, 'useCases', 'acceptance criteria derive only from accepted requirements and UC material');
      if (uc.ok !== true) return uc;
      const inputs = {
        requirementsBundle: { requirements: req.value.sealed.bundle.requirements },
        useCases: { scenarioIds: [...uc.value.acceptedSet.scenarioIds], branchIdsByScenario: { ...uc.value.acceptedSet.branchIdsByScenario } },
        verifiableStatementIds: [...(candidate.deskInput?.verifiableStatementIds ?? [])],
        evidenceBindings: [...(candidate.deskInput?.evidenceBindings ?? [])],
      };
      const built = acceptance.acceptanceUniverseFrom(inputs);
      if (built.ok !== true) return routedRefusal(acceptance.ACCEPTANCE_CHECK_PROVIDER.providerId, built);
      const outcome = acceptance.evaluateAcceptanceGate(
        { ...acceptance.ACCEPTANCE_CHECK_PROVIDER, providerDigest: acceptance.acceptanceProviderDigest() },
        { kind: acceptance.ACCEPTANCE_CELL_PRODUCT_KIND, product: candidate.product },
        built.universe,
        req.value.sealed.bundle.requirements,
      );
      if (outcome.refused === true) return { ok: false, refused: true, reason: outcome.reason, detail: outcome.detail };
      if (outcome.verdict !== 'accepted') {
        return { verdict: outcome.verdict, issues: outcome.issues, providerId: outcome.providerId };
      }
      return { ...outcome, fold: { kind: 'acceptance', universe: built.universe, bundle: candidate.product } };
    }

    /* 5. reconcile-what: the COMPUTED report-only verdict (never hardcoded). */
    case 'reconcile-what': {
      const acc = required(chain, 'acceptance', 'the reconciler validates the complete accepted chain (claim -> intent -> scenario -> requirement -> criterion)');
      if (acc.ok !== true) return acc;
      const req = required(chain, 'requirements', 'the reconciler validates the complete accepted chain');
      if (req.ok !== true) return req;
      const uc = required(chain, 'useCases', 'the reconciler validates the complete accepted chain');
      if (uc.ok !== true) return uc;
      const prd = required(chain, 'prd', 'the reconciler validates the complete accepted chain');
      if (prd.ok !== true) return prd;
      const snapshot = {
        universe: acc.value.universe,
        requirements: req.value.sealed.bundle.requirements,
        acceptance: {
          criteria: acc.value.bundle.criteria,
          deferrals: acc.value.bundle.deferrals ?? [],
          standaloneEvidenceBindings: acc.value.bundle.standaloneEvidenceBindings ?? [],
        },
        prd: {
          memberIds: [...prd.value.acceptedSet.prdMemberIds],
          scenarioRequiredMemberIds: [...prd.value.acceptedSet.scenarioRequiredMemberIds],
        },
        useCases: {
          scenarioIds: [...uc.value.acceptedSet.scenarioIds],
          branchIdsByScenario: { ...uc.value.acceptedSet.branchIdsByScenario },
        },
      };
      const report = acceptance.reconcileWhat(snapshot);
      if (report.verdict === 'gaps') {
        return {
          verdict: 'repair',
          issues: report.findings.map((finding) => ({ source: 'COVERAGE_GAP', detail: `${finding.direction}: ${finding.detail}` })),
          providerId: 'formalization.reconciliation-structure.v1',
        };
      }
      return {
        verdict: 'accepted',
        issues: [],
        providerId: 'formalization.reconciliation-structure.v1',
        productRef: null,
        fold: { kind: 'reconciliation', report },
      };
    }

    /* 6. freeze-what-baseline: exact accepted surfaces, never a scan. */
    case 'freeze-what-baseline': {
      const frozen = whatFreeze.freezeWhatBaseline(candidate.surfaces, candidate.options ?? {});
      if (frozen.ok !== true) {
        return { ok: false, refused: true, reason: frozen.reason, detail: frozen.detail };
      }
      if (frozen.outcome !== 'frozen') {
        // The declared freeze routing (protocol.mjs): drift-detected/indeterminate
        // are typed waits (D12/D5); repair/upstream-repair re-run the desk.
        const verdict = frozen.outcome === 'drift-detected' || frozen.outcome === 'indeterminate' ? 'human-wait' : frozen.outcome === 'upstream-repair' ? 'upstream-repair' : 'repair';
        return {
          verdict,
          issues: [{ source: frozen.refusal?.reason ?? 'MISSING_LINEAGE', detail: frozen.refusal?.detail ?? `the freeze desk outcome is ${frozen.outcome}` }],
          providerId: whatFreezeProtocol.FREEZE_AUTHOR_GATE_ID,
          wait: frozen.wait ?? null,
        };
      }
      return {
        verdict: 'accepted',
        issues: [],
        providerId: whatFreezeProtocol.FREEZE_AUTHOR_GATE_ID,
        productRef: frozen.artifact.ref,
        fold: { kind: 'baseline', baseline: frozen.baseline, artifact: frozen.artifact },
      };
    }

    /* 7. define-architecture-contract: the SRS realization cell. */
    case 'define-architecture-contract': {
      const baseline = required(chain, 'baseline', 'the SRS realizes the frozen whole-WHAT baseline and the accepted UC set');
      if (baseline.ok !== true) return baseline;
      const srsRevisionDigest = candidate.deskInput?.srsRevisionDigest;
      if (typeof srsRevisionDigest !== 'string' || !/^[0-9a-f]{64}$/.test(srsRevisionDigest)) {
        return { ok: false, refused: true, reason: 'MISSING_LINEAGE', detail: 'the architecture desk requires the accepted SRS revision digest pin (fail-closed; never a guessed revision)' };
      }
      const frozen = baseline.value;
      const universe = {
        idSets: {
          evidenceBindingIds: frozen.baseline.evidenceBindings.map((binding) => binding.evidenceBindingId),
          ucScenarioIds: frozen.baseline.containers.uc.members.map((member) => member.scenarioId),
        },
        revisionPins: {
          srsRevisionDigest,
          whatBaselineDigest: frozen.artifact.digest,
        },
      };
      const draft = candidate.product;
      if (draft !== null && typeof draft === 'object' && draft.lineage !== undefined) {
        draft.lineage.baselineRef = `sha256:${universe.revisionPins.whatBaselineDigest}`;
      }
      const assembly = srsRealization.authorArchitectureContract(draft, universe);
      if (assembly.ok !== true) {
        const verdict = assembly.reason === 'FOREIGN_LINEAGE' ? 'upstream-repair' : assembly.reason === 'DRIFT_DETECTED' ? 'human-wait' : assembly.reason === 'SCOPE_VIOLATION' ? 'terminal-reject' : 'repair';
        return { verdict, issues: [{ source: assembly.reason, detail: assembly.detail }], providerId: 'formalization.srs-structure.v1' };
      }
      return {
        verdict: 'accepted',
        issues: [],
        providerId: 'formalization.srs-structure.v1',
        productRef: `sha256:${assembly.product.canonicalDigest}`,
        fold: {
          kind: 'srs',
          architectureContract: assembly.product,
          srsAuthority: {
            revisionDigest: assembly.product.postFreeze.revisionDigest,
            realizationEntryIds: [...assembly.product.postFreeze.realizationEntryIds],
            surfaces: [...assembly.product.postFreeze.surfaces],
          },
        },
      };
    }

    /* 8. settle-formalization: the binding-aware settlement ladder. */
    case 'settle-formalization': {
      const baseline = required(chain, 'baseline', 'settlement consumes the frozen whole-WHAT baseline and the accepted SRS revision');
      if (baseline.ok !== true) return baseline;
      const srs = required(chain, 'srs', 'settlement consumes the frozen whole-WHAT baseline and the accepted SRS revision');
      if (srs.ok !== true) return srs;
      const repositoryPolicyRefs = candidate.deskInput?.repositoryPolicyRefs;
      if (!Array.isArray(repositoryPolicyRefs) || repositoryPolicyRefs.length === 0) {
        return { ok: false, refused: true, reason: 'MISSING_LINEAGE', detail: 'settlement requires the post-freeze repository/policy authority refs (fail-closed; never discovered)' };
      }
      const settled = whatFreezeSettlement.settleSolutionContract({
        frozenBaseline: baseline.value.baseline,
        baselineArtifact: baseline.value.artifact,
        srs: srs.value.srsAuthority,
        repositoryPolicyRefs: [...repositoryPolicyRefs],
        handoff: candidate.product,
      });
      if (settled.ok !== true) {
        return { ok: false, refused: true, reason: settled.refusal?.reason ?? 'MALFORMED_PRODUCT', detail: settled.refusal?.detail ?? 'the settlement ladder refused' };
      }
      if (settled.outcome !== 'formalized') {
        // The declared settlement routing (protocol.mjs): inconsistent ->
        // domain.inconsistent (terminal-reject at the gate); failed ->
        // domain.failed; the gate never seals a partial contract.
        return {
          verdict: 'terminal-reject',
          issues: [{ source: settled.refusal?.reason ?? 'MISSING_LINEAGE', detail: settled.refusal?.detail ?? `the settlement outcome is ${settled.outcome}` }],
          providerId: whatFreezeProtocol.SETTLE_FINAL_GATE_ID,
          outcome: settled.outcome,
        };
      }
      return {
        verdict: 'accepted',
        issues: [],
        providerId: whatFreezeProtocol.SETTLE_FINAL_GATE_ID,
        productRef: settled.artifact.ref,
        fold: { kind: 'solution', contract: settled.contract, artifact: settled.artifact, repositoryPolicyRefs: [...repositoryPolicyRefs] },
      };
    }

    default:
      return { ok: false, refused: true, reason: 'DESK_NOT_INSTALLED', detail: `desk ${deskId} is not an installed semantic dispatch surface` };
  }
}

/* ------------------------------------------------------------------ */
/* The system-requirements seam binding (installed wiring)              */
/* ------------------------------------------------------------------ */

import * as requirementsValidator from '../contracts/validators/requirements-bundle.mjs';

let boundRequirementsSeam = null;

/**
 * The in-package WP03 requirements-bundle validator bound through the
 * cell's fail-closed seam (self-tested: an imposter validator is never
 * bound). Bound once per process; re-derivation is idempotent.
 */
export function installedRequirementsSeamBinding() {
  if (boundRequirementsSeam === null) {
    const binding = systemRequirements.bindWp03RequirementsValidator(requirementsValidator);
    if (binding.bound !== true) {
      throw new Error(`FORMALIZATION_DISPATCH: the in-package requirements validator failed its seam self-test: ${binding.detail}`);
    }
    boundRequirementsSeam = binding;
  }
  return boundRequirementsSeam;
}
