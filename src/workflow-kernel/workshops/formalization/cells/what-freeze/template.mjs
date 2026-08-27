/**
 * workflow-kernel/workshops/formalization/cells/what-freeze/template.mjs -
 * the authoring/provisioning TEMPLATE of the WHAT-freeze desk (FRF-WP07).
 *
 * The template is the deterministic skeleton the desk worker (operator
 * reviewer, or the driver's provisioning surface) fills: one block per
 * WP03 section, each with its carried-surface binding. By construction
 * the template has NO fold slot: the five disposition sections and the
 * evidence bindings are distinct blocks, so a draft that loses a
 * section cannot even be RENDERED lawfully - the shape check refuses it
 * before any digest is computed (the structural half of the F-8 kill).
 *
 * PURITY: pure data + pure checks. No I/O.
 */

import { refused, sha256OfCanonical } from './shared.mjs';
import { PRE_FREEZE_DESKS } from './protocol.mjs';

/** The template's declared section blocks (the WP03 payload sections). */
export const TEMPLATE_SECTIONS = Object.freeze([
  'caseIdentity',
  'sourceManifests.claims',
  'sourceManifests.constraints',
  'sourceManifests.terminalClaims',
  'acceptanceRecords',
  'containers.prd',
  'containers.uc',
  'containers.fr',
  'containers.nfr',
  'containers.rule',
  'containers.ac',
  'traceSet',
  'dispositions.assumption',
  'dispositions.constraint',
  'dispositions.deferred',
  'dispositions.outOfScope',
  'dispositions.unknown',
  'evidenceBindings',
  'developmentSurface',
]);

/** Render the empty template for one case (every section an explicit block). */
export function freezeTemplate(caseIdentity) {
  const template = {
    schemaVersion: 'frf-contracts.what-baseline-template.v1',
    caseIdentity: {
      discoveryCertificateRef: caseIdentity?.discoveryCertificateRef ?? '<the accepted Discovery certificate ref>',
      formalizationCaseRef: caseIdentity?.formalizationCaseRef ?? '<the accepted FormalizationCase ref>',
    },
    sourceManifests: {
      claims: { ids: ['<exact accepted source claim ids>'], manifestDigest: '<64-hex manifest digest>' },
      constraints: { ids: ['<exact accepted source constraint ids>'], manifestDigest: '<64-hex manifest digest>' },
      terminalClaims: { ids: ['<exact accepted terminal claim ids>'], manifestDigest: '<64-hex manifest digest>' },
    },
    acceptanceRecords: PRE_FREEZE_DESKS.map((deskId) => ({
      deskId,
      candidateSetRef: '<sha256:<64-hex> of the accepted CandidateSet>',
      cellFinalAcceptanceRef: '<sha256:<64-hex> of the accepted CellFinalAcceptance>',
      workplaceProductionRevisionRef: '<sha256:<64-hex> of the accepted WorkplaceProductionRevision>',
    })),
    containers: {
      prd: { revisionDigest: '<accepted revision pin>', members: [{ memberId: '<id>', digest: '<content digest>' }] },
      uc: { revisionDigest: '<accepted revision pin>', members: [{ scenarioId: '<id>', digest: '<content digest>', branches: [{ branchId: '<id>', digest: '<content digest>' }] }] },
      fr: { revisionDigest: '<accepted revision pin>', members: [{ memberId: '<id>', digest: '<content digest>' }] },
      nfr: { revisionDigest: '<accepted revision pin>', members: [{ memberId: '<id>', digest: '<content digest>' }] },
      rule: { revisionDigest: '<accepted revision pin>', members: [{ memberId: '<id>', digest: '<content digest>' }] },
      ac: { revisionDigest: '<accepted revision pin>', members: [{ criterionId: '<id>', digest: '<content digest>' }] },
    },
    traceSet: { traces: [{ fromRef: '<id>', kind: '<one of the closed eight-rule grammar>', toRef: '<id>' }] },
    dispositions: {
      assumption: [{ subjectRef: '<id>' }],
      constraint: [{ subjectRef: '<id>', reason: '<why pinned>' }],
      deferred: [{ subjectRef: '<id>', owner: '<owner>', reason: '<reason>' }],
      outOfScope: [{ subjectRef: '<id>', owner: '<owner>', reason: '<reason>' }],
      unknown: [{ subjectRef: '<id>' }],
    },
    evidenceBindings: [{ evidenceBindingId: '<id>', evidenceKind: '<test|monitoring|audit|independent-agent-review>', subjectRef: '<id>' }],
    developmentSurface: {
      handoffBindingKinds: '<the twelve kinds, each resolvesAgainst its exact frozen surfaces>',
      workItemObligationKinds: '<the five kinds, each resolvesAgainst its exact frozen surfaces>',
    },
  };
  return { digest: sha256OfCanonical(template), template };
}

/**
 * Check a draft against the template SHAPE: every declared section must
 * be present as its own named block. A folded draft (dispositions or
 * evidence bindings collapsed into another section, or the legacy
 * memberDigests shape) is refused typed - structurally, before any
 * digest or validator runs.
 */
export function checkTemplateShape(draft) {
  if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
    return refused('MALFORMED_PRODUCT', 'the freeze draft is not an object');
  }
  if (draft.memberDigests !== undefined || draft.acceptedTraceDigest !== undefined) {
    return refused('MALFORMED_PRODUCT', 'the freeze draft carries the folded legacy shape (memberDigests/acceptedTraceDigest): the template has no fold slot (F-8 / ledger D-10)');
  }
  const missing = [];
  if (draft.caseIdentity === undefined) missing.push('caseIdentity');
  if (draft.sourceManifests?.claims === undefined) missing.push('sourceManifests.claims');
  if (draft.sourceManifests?.constraints === undefined) missing.push('sourceManifests.constraints');
  if (draft.sourceManifests?.terminalClaims === undefined) missing.push('sourceManifests.terminalClaims');
  if (!Array.isArray(draft.acceptanceRecords)) missing.push('acceptanceRecords');
  for (const key of ['prd', 'uc', 'fr', 'nfr', 'rule', 'ac']) {
    if (draft.containers?.[key] === undefined) missing.push(`containers.${key}`);
  }
  if (draft.traceSet?.traces === undefined) missing.push('traceSet');
  for (const section of ['assumption', 'constraint', 'deferred', 'outOfScope', 'unknown']) {
    if (draft.dispositions?.[section] === undefined || !Array.isArray(draft.dispositions[section])) {
      missing.push(`dispositions.${section}`);
    }
  }
  if (!Array.isArray(draft.evidenceBindings)) missing.push('evidenceBindings');
  if (draft.developmentSurface?.handoffBindingKinds === undefined || draft.developmentSurface?.workItemObligationKinds === undefined) {
    missing.push('developmentSurface');
  }
  if (missing.length > 0) {
    return refused('MALFORMED_PRODUCT', `the freeze draft is missing its own section(s): ${missing.join(', ')} (the template declares every WP03 section as a distinct block; folding is refused)`);
  }
  return { ok: true, sections: [...TEMPLATE_SECTIONS] };
}
