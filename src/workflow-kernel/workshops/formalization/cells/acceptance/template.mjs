/**
 * FRF-WP06 define-acceptance-contract cell - THE OUTPUT TEMPLATE.
 *
 * The structural skeleton the desk author instantiates: one AC binding
 * payload (frf-contracts.ac-binding.v1 - the WP03 contract), one
 * requirement deferral, one standalone evidence binding, and the bundle
 * wrapper. Templates are deep-frozen pure data; the closed vocabularies
 * are enumerated so an author never guesses them.
 *
 * PURITY: pure data. No I/O.
 */

import { WP03_AC_BINDING_KIND } from './wp03-seam.mjs';
import {
  ACCEPTANCE_BUNDLE_SCHEMA_VERSION,
  EVIDENCE_KINDS,
} from './protocol.mjs';

function deepFrozen(value) {
  if (Array.isArray(value)) {
    for (const entry of value) deepFrozen(entry);
    Object.freeze(value);
    return value;
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFrozen(value[key]);
    Object.freeze(value);
  }
  return value;
}

/** The per-criterion template (frf-contracts.ac-binding.v1 fields). */
export const AC_BINDING_TEMPLATE = deepFrozen({
  schemaVersion: WP03_AC_BINDING_KIND,
  criterionId: 'ac:<stable-atomic-id>',
  bindsTo: {
    requirementRefs: ['fr:exact-accepted-id | nfr:exact-accepted-id'],
    ucScenarioRefs: ['uc:owning-scenario-of-the-bound-requirement (required for scenario-facing criteria)'],
    ucTerminalBranchRefs: ['branch:terminal-branch-of-that-scenario (required together with ucScenarioRefs)'],
  },
  evidence: {
    evidenceKind: 'one of: ' + EVIDENCE_KINDS.join(' | '),
    observableTerminalResult: 'the observable terminal result verified end to end',
  },
  verifiableStatementRefs: ['stmt:accepted-verifiable-statement-id'],
});

/** The forbidden WHAT-side keys (instantiating them is SCOPE_VIOLATION). */
export const TEMPLATE_FORBIDDEN_KEYS = Object.freeze([
  'files',
  'moduleAllocation',
  'participatingModules',
]);

/** The requirement deferral template (the coverage-closure disposition). */
export const DEFERRAL_TEMPLATE = deepFrozen({
  requirementId: 'fr:uncovered-requirement | nfr:uncovered-requirement',
  disposition: 'deferred',
  owner: 'the accountable owner (required)',
  reason: 'why no AC verifies this requirement now (required)',
});

/** The standalone evidence-binding template (cr-05 non-AC coverer). */
export const EVIDENCE_BINDING_TEMPLATE = deepFrozen({
  evidenceBindingId: 'ev:accepted-evidence-binding-id',
  evidenceKind: 'one of: ' + EVIDENCE_KINDS.join(' | '),
  ucTerminalBranchRefs: ['branch:required-terminal-result-this-binding-covers'],
  observableTerminalResult: 'the observable terminal result this binding verifies',
});

/** The bundle wrapper template (the desk's product). */
export const ACCEPTANCE_BUNDLE_TEMPLATE = deepFrozen({
  schemaVersion: ACCEPTANCE_BUNDLE_SCHEMA_VERSION,
  criteria: [AC_BINDING_TEMPLATE],
  deferrals: [DEFERRAL_TEMPLATE],
  standaloneEvidenceBindings: [EVIDENCE_BINDING_TEMPLATE],
});

/** Render the author-facing template as documented text. */
export function renderTemplateGuide() {
  return [
    '# define-acceptance-contract - authoring template',
    '',
    'Instantiate ONE bundle. Every criterion is a frf-contracts.ac-binding.v1',
    'payload validated by the WP03 seam; the closure validators close the set.',
    '',
    'Laws (see the desk skill checklist):',
    ...AC_BINDING_LAW_LINES,
    '',
    'Never add any of: ' + TEMPLATE_FORBIDDEN_KEYS.join(', ') + ' (WHAT-side fence).',
  ].join('\n');
}

const AC_BINDING_LAW_LINES = Object.freeze([
  '- bind exact accepted FR or NFR material (RULE is not AC-bindable);',
  '- scenario-facing criteria retain BOTH the UC scenario AND the terminal-branch citation;',
  '- evidence kind is the closed four-value vocabulary with an observable terminal result;',
  '- every FR/NFR is covered by a criterion or explicitly deferred (owner + reason);',
  '- every required UC terminal result is covered by a criterion or an accepted evidence binding;',
  '- criterion ids are unique across the bundle.',
]);
