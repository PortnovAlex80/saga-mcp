/**
 * tools/frf-corpus/lib/mutations.mjs - the FRF input-fault materializers
 * (FRF-WP10): pure data transformations over the green seed material,
 * one per closed (kind x target) pair of the scenario contract.
 *
 * A mutation is DATA (never kernel code): it rewrites the authored green
 * input at one named surface so the owning desk's exported validator
 * refuses it typed. The materializers never touch the frozen WP03 docs
 * fixtures on disk (every seed is deep-cloned before mutation).
 */

import {
  acceptedSurfacesOf,
  clone,
  greenAcceptanceBundle,
  greenAcceptanceInputs,
  greenBaselineFixture,
  greenPrdBundle,
  greenRealizationDraft,
  greenReqDeskInput,
  greenReqMembers,
  greenUcBundle,
  lawfulHandoffOf,
} from './material.mjs';

/** A stable foreign id outside every accepted id set (the universe kill). */
export const FOREIGN_ID = 'x:foreign-not-in-any-accepted-set';

/* ------------------------------------------------------------------ */
/* Desk-input materializers                                            */
/* ------------------------------------------------------------------ */

/**
 * Build the desk-chain inputs (the green seed material, mutated at ONE
 * named target). Returns the full input pack the chain driver consumes:
 *   { prd: {bundle, universe}, uc: bundle, req: {deskInput, members},
 *     acceptance: {inputs, bundle}, surfaces, srs, handoff, draft }
 */
export function chainInputsFor(mutation = null) {
  const prdBundle = greenPrdBundle();
  const ucBundle = greenUcBundle();
  const reqDeskInput = greenReqDeskInput();
  const reqMembers = greenReqMembers();
  const acceptanceInputs = greenAcceptanceInputs();
  const acceptanceBundle = greenAcceptanceBundle();
  const surfaces = acceptedSurfacesOf();
  const handoff = lawfulHandoffOf();
  const draft = greenRealizationDraft();
  const target = mutation?.target ?? null;
  const kind = mutation?.kind ?? null;
  /** A stale PRD revision pin cited by the BUNDLE while the accepted
   * universe (deriveAcceptedUniverse input) keeps the TRUE pin - the two
   * must diverge for the stale-lineage kill to be observable. */
  let prdRevisionPinOverride = null;

  switch (target) {
    case 'define-product-intent:sourceClaimRefs':
      prdBundle.members[0] = { ...prdBundle.members[0], sourceClaimRefs: [FOREIGN_ID] };
      break;
    case 'model-use-cases:prdIntentRefs':
      ucBundle.scenarios[0] = { ...ucBundle.scenarios[0], prdIntentRefs: [FOREIGN_ID] };
      break;
    case 'derive-system-requirements:prdRevisionPin':
      if (kind === 'stale-binding') prdRevisionPinOverride = 'e'.repeat(64);
      break;
    case 'derive-system-requirements:prdIntentRefs':
      reqMembers[0] = { ...reqMembers[0], prdIntentRefs: [FOREIGN_ID] };
      break;
    case 'define-acceptance-contract:requirementRefs':
      acceptanceBundle.criteria[0] = {
        ...acceptanceBundle.criteria[0],
        bindsTo: { ...acceptanceBundle.criteria[0].bindsTo, requirementRefs: [FOREIGN_ID] },
      };
      break;
    case 'define-acceptance-contract:ucTerminalBranchRefs':
      acceptanceBundle.criteria[0] = {
        ...acceptanceBundle.criteria[0],
        bindsTo: { ...acceptanceBundle.criteria[0].bindsTo, ucTerminalBranchRefs: [] },
      };
      break;
    case 'reconcile-what:snapshot':
      // handled by the reconciliation driver (a drifted snapshot, not a desk input)
      break;
    case 'freeze-what-baseline:containers.uc.members':
      // Substitute one accepted UC member's material with another
      // member's (a member from a newer execution under a retained id):
      // the duplicate member digest is the validator's own substitution
      // detector ("an artifact was substituted or emitted twice").
      surfaces.containers.uc.members[0] = {
        ...surfaces.containers.uc.members[0],
        digest: surfaces.containers.uc.members[surfaces.containers.uc.members.length - 1].digest,
      };
      break;
    case 'freeze-what-baseline:containers.fr+nfr': {
      // Fold the NFR section into the FR container: every NFR member is
      // carried by TWO sections (the folded legacy shape - one section
      // standing for two kinds of content; the exact-authority ingestion
      // detects the duplicate member carrier).
      surfaces.containers = {
        ...surfaces.containers,
        fr: {
          ...surfaces.containers.fr,
          members: [...surfaces.containers.fr.members, ...surfaces.containers.nfr.members],
        },
      };
      break;
    }
    case 'freeze-what-baseline:surfaces.dispositions':
      // Omit the dispositions surface (the D5 indeterminate-desk path).
      delete surfaces.dispositions;
      break;
    case 'settle-formalization:handoff.scenario-bindings':
      // Strip the scenario bindings while retaining the AC ids (the
      // audit's named stripping attack - ledger D-2/D-17).
      delete handoff['scenario-bindings'];
      break;
    case 'settle-formalization:handoff.requirement-bindings':
      handoff['requirement-bindings'] = [FOREIGN_ID];
      break;
    case 'define-architecture-contract:entrypoint':
      // Remove the entrypoint surface from the contract (the Elite
      // missing-entrypoint kill): the checkout entry stays named as the
      // entrypoint but is declared by no surface of the contract.
      draft.realizationEntries[0] = {
        ...draft.realizationEntries[0],
        participatingSurfaceRefs: ['module:audit-log'],
        runtimeEdges: [{ fromSurfaceRef: 'module:audit-log', toSurfaceRef: 'terminal:checkout-rendered' }],
      };
      draft.surfaces = draft.surfaces.filter((surface) => surface.surfaceId !== 'svc:cart-api');
      break;
    case 'define-architecture-contract:composition':
      // Declare an orphan composition surface realizing no scenario (the
      // Elite missing-composition kill).
      draft.surfaces = [...draft.surfaces, {
        description: 'an orphan composer realizing nothing',
        realizedScenarioRefs: [],
        surfaceId: 'svc:orphan-composer',
        surfaceKind: 'composition',
      }];
      break;
    case 'admit-development-case:scenario-bindings':
      // handled by the case driver (a foreign-binding case candidate)
      break;
    case 'plan-development:scenario-realization':
    case 'replan-development:mutated-survivor':
      break;
    default:
      if (target !== null) throw new Error(`unknown mutation target "${String(target)}"`);
  }

  return {
    acceptance: { bundle: acceptanceBundle, inputs: acceptanceInputs },
    handoff,
    prd: { bundle: prdBundle },
    prdRevisionPinOverride,
    req: { deskInput: reqDeskInput, members: reqMembers },
    surfaces,
    uc: ucBundle,
  };
}

/* ------------------------------------------------------------------ */
/* The drifted reconciliation snapshot (F-2: the gaps verdict computed) */
/* ------------------------------------------------------------------ */

/**
 * The drifted reconciliation snapshot input (F-2: the gaps verdict
 * computed): clone the GREEN run's accepted snapshot and mutate one
 * criterion's requirement binding after acceptance. The report must
 * COMPUTE the gaps verdict from the drift, never trust a declared one.
 */
export function driftAcceptanceCriteria(snapshot) {
  const drifted = clone(snapshot);
  drifted.acceptance.criteria[0] = {
    ...drifted.acceptance.criteria[0],
    bindsTo: { ...drifted.acceptance.criteria[0].bindsTo, requirementRefs: [FOREIGN_ID] },
  };
  return drifted;
}

/* ------------------------------------------------------------------ */
/* The Elite kill drafts (over the WP08 elite fixture universe)        */
/* ------------------------------------------------------------------ */

/**
 * The Elite missing-entrypoint draft: the browser-bootstrap surface of
 * the interactive scenario is removed from the contract (the surface a
 * scenario's entrypoint resolves through is absent).
 */
export function eliteMissingEntrypointDraft(eliteDraft) {
  const mutated = clone(eliteDraft);
  const entry = mutated.realizationEntries.find((item) => item.realizationEntryId === 'realization:elite-interactive');
  entry.participatingSurfaceRefs = entry.participatingSurfaceRefs.filter((id) => id !== 'arch:elite-browser-bootstrap');
  entry.runtimeEdges = entry.runtimeEdges.filter((edge) => edge.fromSurfaceRef !== 'arch:elite-browser-bootstrap' && edge.toSurfaceRef !== 'arch:elite-browser-bootstrap');
  entry.entrypointSurfaceRef = 'arch:elite-domain';
  mutated.surfaces = mutated.surfaces.filter((surface) => surface.surfaceId !== 'arch:elite-browser-bootstrap');
  return mutated;
}

/** The Elite missing-composition draft: an orphan composition surface. */
export function eliteMissingCompositionDraft(eliteDraft) {
  const mutated = clone(eliteDraft);
  mutated.surfaces = [...mutated.surfaces, {
    description: 'an orphan composer realizing no scenario',
    realizedScenarioRefs: [],
    surfaceId: 'arch:orphan-composer',
    surfaceKind: 'composition',
  }];
  return mutated;
}

/* ------------------------------------------------------------------ */
/* The DevelopmentCase / plan mutations                                */
/* ------------------------------------------------------------------ */

/** A case candidate whose scenario bindings were substituted (the consumer UC-FOREIGN kill). */
export function foreignScenarioBindingsCase(devCase) {
  const mutated = clone(devCase);
  mutated.scenarioBindings = [{ scenarioId: FOREIGN_ID }];
  return mutated;
}

/** Drop the batch scenario-realization obligation from the work items (the AC-complete/scenario-incomplete kill). */
export function scenarioIncompleteWorkItemInputs(inputs) {
  const mutated = clone(inputs);
  const batch = mutated.find((input) => input.workItemId === 'wi:batch');
  // Keep every acceptance and requirement obligation (AC-complete) while
  // stripping the scenario-realization obligation (scenario-incomplete).
  delete batch.scenarioRealization;
  // The verifier keeps both realization entries covered... but the plan
  // gate requires a scenario-realization obligation per entry: dropping
  // only the batch's realization leaves the entry uncovered (the verifier
  // obligation is a different obligation class).
  return mutated;
}

/** Mutate one surviving work item's obligations (the replan identity kill). */
export function mutatedSurvivorInputs(inputs) {
  const mutated = clone(inputs);
  const checkout = mutated.find((input) => input.workItemId === 'wi:checkout');
  // ADD an obligation to a SURVIVOR: the coverage gates still pass (the
  // added requirement is a lawful case domain id) but the survivor's
  // workItemDigest changes - identities are immutable per WorkItem.
  checkout.requirements = [...checkout.requirements, 'fr:batch-1'];
  return mutated;
}

/** The green baseline fixture accessor (the frozen independent evidence). */
export const frozenGreenBaseline = greenBaselineFixture;
