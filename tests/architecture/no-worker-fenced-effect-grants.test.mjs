// tests/architecture/no-worker-fenced-effect-grants.test.mjs
//
// The §27 ratchet (stage-8, TASK A4) — CONVEYOR-MENTAL-MODEL.md:1305-1306:
// "CI should mechanically reject at least: … LM profiles that can mutate
// canonical Git refs, merge or issue integration authority."
//
// THE FAILURE THIS PREVENTS. A worker holding a merge tool + a dirtied state
// column + a receipt-issuing effect = a manufactured factory receipt over a
// merge that never happened (the G3 dossier's defect A and defect B). Stage 7
// closed B (ancestry is the sole merge proof); stage 8 closed A (the grant).
// THIS TEST is why neither can quietly return: the grant survived K11's exit
// gate precisely because no ratchet existed to catch it.
//
// WHAT IT ASSERTS. No execution profile of any module — built-in or ext —
// grants a tool on the FORBIDDEN list. Profiles are enumerated from IMPORTED
// module definitions (the same objects the runtime registers), not from
// grepping source text. Profile-level assertion is the strongest
// profile-side guarantee: the effective capability set is the least-privilege
// intersection profile.allowedTools ∩ runtime grants ∩ driver builtins
// (capability-enforcement.ts) — a tool absent from the profile can NEVER
// reach the worker, whatever a runtime grants.
//
// EXTENDING THE FORBIDDEN SET is a deliberate architectural act: add the
// tool, its reason, and its ADR reference, in the same commit as the decision
// that fences it. Candidates considered and deliberately NOT fenced yet
// (do not add without an architect's decision): worker_next (already excluded
// by the capability package, different rationale), verification_record,
// repository_checkout_register/bootstrap, process_node_submit.

import assert from 'node:assert/strict';
import test from 'node:test';

import { discoveryProcessModule } from '../../dist/process-modules/modules/discovery/discovery-process-module.js';
import { formalizationProcessModule } from '../../dist/process-modules/modules/formalization/formalization-process-module.js';
import { developmentProcessModule } from '../../dist/process-modules/modules/development/development-process-module.js';
import { developmentContinuationProcessModule } from '../../dist/process-modules/modules/development/development-continuation-process-module.js';
import { developmentVerificationContinuationProcessModule } from '../../dist/process-modules/modules/development/development-verification-continuation-process-module.js';
import { deliveryProcessModule } from '../../dist/process-modules/modules/delivery/delivery-process-module.js';
import { createRequire } from 'node:module';

// modules-ext is repo-root, outside the compiled tree — the external-seo
// package test set the precedent of importing it directly.
const require = createRequire(import.meta.url);
const { lmMarketingModule } = require('../../modules-ext/lm-marketing/definition.mjs');

/**
 * Tools that perform a FENCED FACTORY EFFECT and must never appear in a
 * worker execution profile's allowedTools. Rationale per entry; the list
 * grows only by deliberate architectural decision (same commit as the
 * decision, with the reason stated here).
 */
const FORBIDDEN_WORKER_TOOLS = Object.freeze([
  {
    tool: 'worker_merge_acquire',
    reason: 'merge-lock acquire — the worker-side half of a worker-selected '
      + 'merge authority; integration is the fenced git-integration Factory '
      + 'effect (CONVEYOR §18:847-848: only a fenced Factory effect may '
      + 'create/update canonical refs, merge, push or issue an integration '
      + 'receipt)',
    reference: 'ADR-039 follow-up "remove worker_merge_* from LM profiles"; '
      + 'K11 commit 4 "no worker-selected merge authority"; G3 dossier §9 '
      + 'defect A; removed in stage-8',
  },
  {
    tool: 'worker_merge_release',
    reason: 'records an unverified worker-attested integration outcome '
      + '(integration_state/integrated_commit written from the tool argument '
      + 'with no git verification) — a worker must not issue integration '
      + 'authority',
    reference: 'same as worker_merge_acquire (stage-8, defect A)',
  },
]);

const MODULES = Object.freeze([
  { name: 'discovery', module: discoveryProcessModule },
  { name: 'formalization', module: formalizationProcessModule },
  { name: 'development', module: developmentProcessModule },
  { name: 'development-continuation', module: developmentContinuationProcessModule },
  { name: 'development-verification-continuation', module: developmentVerificationContinuationProcessModule },
  { name: 'delivery', module: deliveryProcessModule },
  { name: 'modules-ext:lm-marketing', module: lmMarketingModule },
]);

test('no execution profile of any module grants a fenced-effect tool (the §27 ratchet)', () => {
  const violations = [];
  let profileCount = 0;
  for (const { name, module } of MODULES) {
    const profiles = module?.executionProfiles ?? [];
    for (const profile of profiles) {
      profileCount += 1;
      const tools = Array.isArray(profile.allowedTools) ? profile.allowedTools : [];
      for (const forbidden of FORBIDDEN_WORKER_TOOLS) {
        if (tools.includes(forbidden.tool)) {
          violations.push(
            `${name}/${profile.id} grants ${forbidden.tool} — ${forbidden.reason} [${forbidden.reference}]`,
          );
        }
      }
    }
  }
  assert.deepEqual(violations, [],
    `execution profiles granting fenced-effect tools (CONVEYOR §27 — a worker must not hold these):\n  ${violations.join('\n  ')}`);
  // The enumeration must stay alive: if every module lost its profiles the
  // scan above would pass vacuously.
  assert.ok(profileCount >= 12,
    `profile enumeration shrank unexpectedly (${profileCount} profiles across ${MODULES.length} modules) — update the module list deliberately`);
  console.log(`[no-worker-fenced-effect-grants] ${MODULES.length} modules, ${profileCount} profiles, forbidden set = ${FORBIDDEN_WORKER_TOOLS.map((f) => f.tool).join(', ')}`);
});
